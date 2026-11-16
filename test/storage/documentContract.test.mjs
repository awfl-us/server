import {test} from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, assertStorage, objectValue, patch, partsOf,
  validatePath, validateQuery } from '../../storage/document/contract.js';

test('provider-independent path validation preserves nested namespaces',()=>{
  assert.deepEqual(partsOf('users/u/projects/p/sessions/s'),{
    path:'users/u/projects/p/sessions/s',collectionPath:'users/u/projects/p/sessions',
    collectionId:'sessions',documentId:'s'});
  for (const bad of ['users', 'users/u/projects','users//p','users/../x','users/u/','/users/u', 'users/u\u0000']) {
    assert.throws(()=>validatePath(bad),e=>e.code==='INVALID_PATH');
  }
  assert.equal(validatePath('users/u/projects','collection'),'users/u/projects');
});

test('JSON codec and patch operations never silently lose precision',()=>{
  assert.deepEqual(applyPatch({a:{b:2},count:1,removed:true},{
    'a.b':7, count:patch.increment(2), removed:patch.deleteField(),
    current:patch.serverTimestamp(),
  },()=>new Date('2026-01-01T00:00:00Z')),
  {a:{b:7},count:3,current:'2026-01-01T00:00:00.000Z'});
  assert.throws(()=>objectValue({value:BigInt(4)}),e=>e.code==='INVALID_DATA');
  assert.throws(()=>objectValue({value:NaN}),e=>e.code==='INVALID_DATA');
  assert.throws(()=>objectValue({value:Number.MAX_SAFE_INTEGER+1}),e=>e.code==='INVALID_DATA');
  assert.throws(()=>objectValue({value:undefined}),e=>e.code==='INVALID_DATA');
  assert.throws(()=>applyPatch({a:1},{'a.b':1}),e=>e.code==='INVALID_DATA');
  assert.throws(()=>applyPatch({}, {'a':1,'a.b':2}),e=>e.code==='INVALID_DATA');
});

test('query contract and interface fail closed on incomplete adapters',()=>{
  assert.equal(validateQuery({collection:'users/u/projects',where:[{field:'price',op:'>=',value:100}]}).limit,100);
  for (const bad of [{collection:'users/u/projects',collectionGroup:'projects'},
    {collection:'users/u/projects',where:[{field:'price',op:'IN',value:[1]}]},
    {collection:'users/u/projects',orderBy:{field:'amount',direction:'sideways'}}]) {
    assert.throws(()=>validateQuery(bad),e=>e.code==='INVALID_QUERY');
  }
  assert.throws(()=>assertStorage({get:()=>{}}), /missing create/);
});
