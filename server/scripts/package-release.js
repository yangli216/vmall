// Explicit allowlist: never package local env files, credentials or test fixtures.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const output = path.join(root, '../.runtime/releases', stamp);
const stage = path.join(output, 'server');
fs.mkdirSync(stage, {recursive:true});
for (const file of ['Dockerfile','.dockerignore','.env.example','container.config.json','package.json','package-lock.json','tsconfig.json','src','dist','migrations','scripts/migrate.js','scripts/preflight.js']) {
  const source = path.join(root, file);
  if (!fs.existsSync(source)) throw new Error(`Missing release input: ${file}; run npm run build first`);
  fs.cpSync(source, path.join(stage, file), {recursive:true});
}
if (!fs.existsSync(path.join(stage, 'dist/index.js'))) throw new Error('Compiled server entry is absent');
fs.copyFileSync(path.join(root, '../docs/上线运行与验收.md'), path.join(stage, 'DEPLOYMENT.md'));
function filesIn(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release input contains a symbolic link');
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}
const files = {};
for (const file of filesIn(stage).sort()) files[path.relative(stage, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let sourceHead = 'unknown';
try { sourceHead = execFileSync('git', ['rev-parse','HEAD'], {cwd:root, encoding:'utf8'}).trim(); } catch {}
fs.writeFileSync(path.join(stage, 'release-manifest.json'), JSON.stringify({created_at:new Date().toISOString(),source_git_head:sourceHead,contains_working_tree_changes:true,sha256_files:files},null,2)+'\n');
const archive = path.join(output, `pandou-server-${stamp}.zip`);
execFileSync('zip', ['-q','-r',archive,'.'], {cwd:stage});
execFileSync('unzip', ['-tq',archive], {stdio:'pipe'});
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(archive+'.sha256', `${sha256}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({archive,sha256,files:Object.keys(files).length,manifest:path.join(stage,'release-manifest.json')},null,2));
