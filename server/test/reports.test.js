const {test}=require('node:test');const assert=require('node:assert/strict');
const {reportDay,reportFen,reportYuan}=require('../dist/services/reports');
test('daily reports use exact China calendar bounds and preserve large and negative fen sums',()=>{
 assert.deepEqual(reportDay('2024-02-29'),{day:'2024-02-29',start:'2024-02-29 00:00:00',end:'2024-03-01 00:00:00'});
 assert.equal(reportDay('2026-12-31').end,'2027-01-01 00:00:00');
 for(const day of ['2026-02-29','2026-04-31','2026-00-01','2026-13-01','2026-1-01','2026-01-01 OR 1=1',['2026-01-01'],null])assert.throws(()=>reportDay(day));
 assert.equal(reportYuan(reportFen('900719925474099301.00')),'9007199254740993.01');assert.equal(reportYuan(reportFen('-101.00')),'-1.01');assert.equal(reportYuan(0n),'0.00');
 for(const value of ['1.1','NaN','1e10','Infinity'])assert.throws(()=>reportFen(value));
});
