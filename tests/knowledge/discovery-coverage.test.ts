import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishedDiscoveryCoverage} from '../../src/knowledge/discovery-coverage.ts';
test('query coverage never mixes drafts or unrelated source versions with a published version',()=>{
 const release={id:'release',status:'published',discovery:{sources:[{id:'a'},{id:'b'}],validation:{deferred:[{member:{id:'a.field',name:'属性'},reason:'缺少依据',evidence:[{sourceVersionId:'a'}]},{member:{id:'b.field'},evidence:[{sourceVersionId:'b'}]},{member:{id:'other'},evidence:[{sourceVersionId:'draft-source'}]}]}}};
 const result=publishedDiscoveryCoverage(release,['a','draft-source']);
 assert.equal(result.ontologyId,'release');assert.deepEqual(result.sourceVersionIds,['a']);assert.deepEqual(result.deferred.map((d:any)=>d.memberId),['a.field']);
 assert.equal(publishedDiscoveryCoverage({...release,status:'draft'},['a']).deferred.length,0);
 assert.equal(publishedDiscoveryCoverage(release,['other']).status,'coverage_unknown');
});
