// Local migration only. Uses the existing canonical reader; never publishes data.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = fileURLToPath(new URL('./', import.meta.url));
const frontend = process.env.OC_FRONTEND_ROOT || 'C:/Productbuilder/repos/productbuilder/frontend/pb-frontend-monorepo';
const reference = process.env.HTM_V2_ROOT || 'C:/Productbuilder/repos/hilversumtimemachine/htm-data/dev/schema-v2';
const library = resolve(frontend, 'src/tenants/opencollections/libs/lib-collections/src');
const { canonicalDocument, collectionResults } = await import(pathToFileURL(resolve(library, 'index.js')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => { const target = resolve(out, path); await mkdir(resolve(target, '..'), {recursive:true}); await writeFile(target, json(value)); };
async function inventory(dir, exclude = []) {
  const result = {};
  async function visit(path) { for (const entry of await readdir(path, {withFileTypes:true})) {
    if (exclude.includes(entry.name)) continue;
    const file = resolve(path, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) result[relative(dir, file).replaceAll('\\','/')] = hash(await readFile(file));
  }}
  await visit(dir); return result;
}
const originalHashes = await inventory(root, ['.git', 'schema-v2']);
const referenceHashes = await inventory(reference);
const originalSource = await read(resolve(root, 'source.json'));
const legacy = await read(resolve(root, 'collection.json'));
const base = 'https://raw.githubusercontent.com/sunnywood2000/Albertus-Perk-HTM/main/';
// Deliberately fixed original document URIs, never derived from the new delivery location.
const sourceId = base + 'source.json';
const collectionId = base + 'collection.json';
const sourcePath = 'org/albertus-perk/source.json';
const collectionPath = 'org/albertus-perk/hhkap1/collection.json';
const publishedCollection = base + 'schema-v2/' + collectionPath;
const property = (propertyID, value) => ({'@type':'PropertyValue', propertyID, value:JSON.stringify(value)});
const identityMap = [];
const mediaMappings = [];
const members = legacy.items.map((item, index) => {
  let key = item.id;
  if (index === 6 && item.id === 'NL-HvsHHKAP-011579') {
    assert.equal(item.title, 'Sportpark');
    assert.ok(item.source.endsWith('/NL-HvsHHKAP-006818.jpg'));
    assert.ok(item.media.url.endsWith('/Temp_NL-HvsHHKAP-006818.jpg'));
    key = 'NL-HvsHHKAP-006818';
  }
  const id = collectionId + '#' + encodeURIComponent(key);
  identityMap.push({index, originalId:item.id, evidenceId:key, semanticId:id, imageId:id+'-image', reason:key === item.id ? 'Preserved catalogue identifier' : 'Duplicate reconciled from matching original source URL and media filename; original ID retained in identifier and legacy.record'});
  const media = {};
  for (const [from,to] of [['url','contentUrl'],['thumbnailUrl','thumbnailUrl']]) {
    const raw = item.media[from];
    // Keep existing assets in place, correctly rebasing from four nested directories.
    media[to] = raw.startsWith('./') ? '../../../../' + raw.slice(2).split('/').map(encodeURIComponent).join('/') : raw;
    mediaMappings.push({index, field:to, original:raw, migrated:media[to], resolved:new URL(media[to], publishedCollection).href,
      localFile:raw.startsWith('./') ? raw.slice(2) : null});
  }
  return {'@id':id, '@type':'CreativeWork', identifier:item.id, name:item.title,
    description:item.description, temporalCoverage:String(item.date), keywords:item.tags,
    url:item.source, isBasedOn:{'@type':'CreativeWork',url:item.source},
    contentLocation:{'@type':'Place',geo:{'@type':'GeoCoordinates',latitude:item.location.lat,longitude:item.location.lon}},
    image:{'@id':id+'-image','@type':'ImageObject',...media},
    additionalProperty:[property('legacy.record',item)]};
});
const collection = {'@context':'https://opencollections.org/schema/collection/2.0/context.jsonld',
  '@id':collectionId,'@type':'Collection', identifier:legacy.id,name:legacy.title,description:legacy.description,hasPart:members};
const source = {'@context':'https://opencollections.org/schema/source/2.0/context.jsonld',
  '@id':sourceId,'@type':'DataCatalog',name:originalSource.organizationName,
  hasPart:[{'@id':collectionId,'@type':'Collection',name:legacy.title,url:'./hhkap1/collection.json'}],
  additionalProperty:[property('legacy.sourceMetadata',originalSource)]};
assert.equal(legacy.items.length,11);
assert.equal(new Set(members.map(x=>x['@id'])).size,11);
assert.equal(source.hasPart[0]['@id'],collection['@id']);
await save(sourcePath,source); await save(collectionPath,collection);
await save('identity-map.json',{identityPolicy:'Fixed original public document URIs deliberately adopted as durable semantic identities; retain them if delivery moves. Member fragments use existing catalogue IDs, including the evidence-backed Sportpark correction. No OC registry identity minted.',source:{originalId:originalSource.id,semanticId:sourceId},collection:{originalId:legacy.id,sourceReferenceId:originalSource.collections[0].id,semanticId:collectionId},members:identityMap});

const docs = [];
for (const [path,value] of [[sourcePath,source],[collectionPath,collection]]) {
  const parsed = canonicalDocument.parseDocument(value,{documentUrl:base+'schema-v2/'+path});
  assert.ok(parsed.validation.structural && parsed.validation.semanticSupported);
  assert.equal(parsed.diagnostics.filter(d=>d.severity==='ERROR').length,0);
  docs.push({path,validation:parsed.validation,diagnostics:parsed.diagnostics});
}
const adapter = async url => {
  const parsed = new URL(url);
  let file;
  if (parsed.origin==='https://migration.invalid') file=resolve(reference, decodeURIComponent(parsed.pathname.slice(1)));
  else if (url.startsWith(base+'schema-v2/')) file=resolve(out,decodeURIComponent(url.slice((base+'schema-v2/').length)));
  else throw Error('Unexpected document request: '+url);
  const bytes=await readFile(file);
  return {ok:true,status:200,url,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
};
const entries=[base+'schema-v2/'+sourcePath];
const loaded=await collectionResults.loadCollectionSet(entries,{fetchImpl:adapter});
assert.equal(loaded.results.length,11); assert.equal(loaded.collections.length,1);
assert.equal(loaded.failures.length,0); assert.equal(loaded.conflicts.length,0); assert.equal(loaded.requestCount,2);
assert.equal(loaded.results.filter(r=>r.geometry).length,11);
assert.equal(loaded.results.filter(r=>r.temporal?.start).length,11);
assert.equal(loaded.results.filter(r=>r.previewUrl).length,11);
for (const [i,item] of legacy.items.entries()) {
  const row=loaded.results[i], node=members[i];
  assert.equal(row.title,item.title); assert.equal(row.description,item.description);
  assert.deepEqual(row.geometry.coordinates,[item.location.lon,item.location.lat]);
  assert.equal(node.temporalCoverage,String(item.date));
  assert.equal(node.url,item.source); assert.equal(node.identifier,item.id);
  assert.deepEqual(JSON.parse(node.additionalProperty[0].value),item);
  assert.equal(row.previewUrl,mediaMappings.find(m=>m.index===i && m.field==='thumbnailUrl').resolved);
}
const combined=await collectionResults.loadCollectionSet([...entries,
  'https://migration.invalid/org/collectie-hilversum/source.json',
  'https://migration.invalid/org/dudok-architectuur-centrum/source.json'],{fetchImpl:adapter});
assert.equal(combined.results.length,809); assert.equal(combined.failures.length,0); assert.equal(combined.conflicts.length,0);
for (const mapping of mediaMappings.filter(m=>m.localFile)) {
  assert.ok(Object.hasOwn(originalHashes,mapping.localFile));
  const rebased=resolve(out,collectionPath,'..',decodeURIComponent(mapping.migrated));
  assert.equal(rebased,resolve(root,mapping.localFile));
  const bytes=await readFile(rebased);
  assert.equal(bytes[0],0xff); assert.equal(bytes[1],0xd8);
}
// Only HEAD requests for media; no complete remote image downloads.
async function head(url) {
  try { const r=await fetch(url,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(20000)});
    return {url,status:r.status,finalUrl:r.url,contentType:r.headers.get('content-type'),cors:r.headers.get('access-control-allow-origin'),ok:r.ok};
  } catch(e) {return {url,ok:false,error:e.message};}
}
const remoteChecks=await Promise.all([...new Set(mediaMappings.map(m=>m.resolved))].map(head));
await save('media-validation.json',{checkedAt:new Date().toISOString(),method:'Exact local path and JPEG signature checks for seven assets; HEAD of eleven unique public media URLs, no remote image bodies downloaded',localAssets:7,referenceOccurrences:mediaMappings.length,mappings:mediaMappings,remoteChecks});
const issues=[
  {kind:'source-reference-alias',detail:'hhkapv1 resolves via ./collection.json to the hhkap1 document. One Collection retained; both legacy values preserved. Earlier four-record bobv1/bobv2 project notes are stale for this input.'},
  {kind:'duplicate-id-reconciled',index:6,detail:'Sportpark uses NL-HvsHHKAP-011579 in legacy id but NL-HvsHHKAP-006818 in both source URL and image filename. Semantic fragment uses the latter; original identifier remains unchanged.'},
  {kind:'external-reference-review',index:8,detail:'Geuzenweg NL-HvsHHKAP-013033 source points to NL-HvsHHKAP-013155 (Utrechtseweg). Retained verbatim; correct catalogue URL is not established.'},
  {kind:'rights-attribution-review',detail:'All legacy license values are institution/donation labels, not established licences. Retained exactly inside legacy.record, without asserting publisher, creator, rights holder or image licence.'},
  {kind:'source-title-preserved',detail:'Display name uses organizationName Albertus Perk. Original title Example source, curator and place/country fields remain in legacy.sourceMetadata; no publisher role inferred.'},
  {kind:'legacy-editorial-fields',detail:'type=site, include=true and media.type=image remain in legacy.record; CreativeWork with ImageObject models descriptive records following Hilversum. All 11 included; empty tags retained as keywords.'},
  {kind:'date-semantics',detail:'All numeric years become year-precision temporalCoverage. No image creation date or day precision inferred.'}
];
assert.deepEqual(await inventory(root,['.git','schema-v2']),originalHashes);
assert.deepEqual(await inventory(reference),referenceHashes);
const provenancePath=resolve(library,'logic/canonical-document/fixtures/provenance.json');
const provenance=await read(provenancePath);
const backend=process.env.OC_BACKEND_ROOT || 'C:/Productbuilder/repos/productbuilder/backend/pb-backend-monorepo';
for (const entry of provenance.files.filter(f=>f.path.startsWith('resources/'))) {
  assert.equal(hash(await readFile(resolve(backend,provenance.root,entry.path))),entry.sha256,'Canonical schema/context differs from pinned reader: '+entry.path);
}
await save('migration-evidence.json',{originalSource,originalCollection:legacy,originalFiles:originalHashes,referenceFiles:referenceHashes,issues,
  canonicalReader:{frontend,publicEntry:'src/tenants/opencollections/libs/lib-collections/src/index.js',profileSha256:hash(await readFile(resolve(library,'logic/canonical-document/profile-resources.js'))),provenance:await read(provenancePath)},
  generatorSha256:hash(await readFile(fileURLToPath(import.meta.url))),representativeComparisons:[0,4,6,8,10].map(index=>({index,before:legacy.items[index],after:members[index]}))});
const validation={status:'PASS',scope:'Canonical compact v2 structural/semantic validation and real reader integration; remote media qualification reported separately',documents:docs,
  counts:{legacyMembers:11,legacyUniqueIds:10,migratedMembers:11,migratedUniqueIds:11,relatedImages:11,sources:1,collections:1,mapMembers:11,temporalMembers:11,previewReferences:11},
  reader:{requests:loaded.requestCount,failures:loaded.failures,conflicts:loaded.conflicts,combinedWithHilversum:{members:combined.results.length,collections:combined.collections.length,failures:combined.failures,conflicts:combined.conflicts}},
  checks:{canonicalSchemaAndContextHashesMatch:true,allRecordsCompared:true,orderPreserved:true,relativeReferencesResolved:true,originalFilesUnchanged:true,referenceFilesUnchanged:true},
  media:{localAssets:7,remoteHeadPassed:remoteChecks.filter(r=>r.ok && r.contentType?.startsWith('image/')).length,remoteHeadTotal:remoteChecks.length},
  limitations:['Bounded canonical profile, not unrestricted JSON-LD validation','No browser image decoding or new published v2 endpoint test','External Geuzenweg catalogue mismatch and ambiguous licence labels retained for review']};
await save('validation.json',validation);
console.log(json({...validation,documents:docs.map(d=>({path:d.path,warnings:d.diagnostics.filter(x=>x.severity==='WARNING')}))}));
