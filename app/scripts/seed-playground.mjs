/**
 * Seed the Playground gallery with a few published apps so the gallery + portal
 * aren't empty. Mirrors seed-one-clean.mjs: snapshot → Walrus → publish_app_v2.
 *
 * Key: FORGE_SEED_KEY (a funded testnet suiprivkey, from the gitignored .env).
 * Net: FORGE_NETWORK (testnet | mainnet; testnet uses the free Walrus publisher).
 * Usage: npm run seed:gallery   (root) — or  node --import tsx app/scripts/seed-playground.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { makeContextWithKeypair, publishApp } from '../src/lib/sui.ts';
import { buildSnapshotFromMemory } from '../src/lib/snapshot.ts';
import { storeBlobAuto } from '../src/lib/walrus.ts';

// Load .env (KEY=VALUE) so FORGE_SEED_KEY / FORGE_NETWORK can live in one place.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = join(root, '.env');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const NET = process.env.FORGE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
const KEY = process.env.FORGE_SEED_KEY;
if (!KEY) { console.error('FORGE_SEED_KEY not set (put it in .env).'); process.exit(1); }

const kp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(KEY).secretKey);
const ctx = makeContextWithKeypair(kp, NET);
console.log(`seeding playground on ${NET} as ${ctx.address}`);

const APPS = [
  { name: 'neon-clock', category: 'tool', prompt: 'a neon digital clock', html: '<!doctype html><meta charset=utf-8><body style="margin:0;background:#06080f;display:grid;place-items:center;height:100vh;font-family:monospace"><h1 id=t style="color:#4da2ff;font-size:14vw;text-shadow:0 0 20px #4da2ff"></h1><script>setInterval(()=>t.textContent=new Date().toLocaleTimeString(),250)</script>' },
  { name: 'bouncing-balls', category: 'art', prompt: 'colorful bouncing balls on canvas', html: '<!doctype html><meta charset=utf-8><body style="margin:0;background:#000"><canvas id=c></canvas><script>let x=c.getContext("2d"),W=c.width=innerWidth,H=c.height=innerHeight,b=[...Array(40)].map(()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*6,vy:(Math.random()-.5)*6,r:8+Math.random()*22,h:Math.random()*360}));(function f(){x.fillStyle="rgba(0,0,0,.2)";x.fillRect(0,0,W,H);for(let o of b){o.x+=o.vx;o.y+=o.vy;if(o.x<o.r||o.x>W-o.r)o.vx*=-1;if(o.y<o.r||o.y>H-o.r)o.vy*=-1;x.beginPath();x.fillStyle=`hsl(${o.h},90%,60%)`;x.arc(o.x,o.y,o.r,0,7);x.fill()}requestAnimationFrame(f)})()</script>' },
  { name: 'todo-mini', category: 'tool', prompt: 'a minimal todo list', html: '<!doctype html><meta charset=utf-8><body style="font-family:system-ui;max-width:420px;margin:40px auto;color:#cfe6ff;background:#06080f"><h2>todo</h2><input id=i placeholder="add..." style="width:100%;padding:8px"><ul id=l></ul><script>i.onkeydown=e=>{if(e.key=="Enter"&&i.value){let li=document.createElement("li");li.textContent=i.value;li.onclick=()=>li.remove();l.append(li);i.value=""}}</script>' },
  { name: 'color-picker', category: 'tool', prompt: 'a hex color picker with preview', html: '<!doctype html><meta charset=utf-8><body style="font-family:monospace;display:grid;place-items:center;height:100vh;margin:0" id=b><input type=color id=p oninput="b.style.background=p.value;o.textContent=p.value"><h1 id=o>#000000</h1>' },
  { name: 'starfield', category: 'art', prompt: 'a warp-speed starfield', html: '<!doctype html><meta charset=utf-8><body style="margin:0;background:#000"><canvas id=c></canvas><script>let x=c.getContext("2d"),W=c.width=innerWidth,H=c.height=innerHeight,s=[...Array(300)].map(()=>({x:Math.random()*W-W/2,y:Math.random()*H-H/2,z:Math.random()*W}));(function f(){x.fillStyle="#000";x.fillRect(0,0,W,H);x.fillStyle="#fff";for(let o of s){o.z-=6;if(o.z<1)o.z=W;let k=128/o.z,sx=o.x*k+W/2,sy=o.y*k+H/2,r=(1-o.z/W)*3;x.beginPath();x.arc(sx,sy,r,0,7);x.fill()}requestAnimationFrame(f)})()</script>' },
];

let n = 0;
for (const a of APPS) {
  try {
    const { archive, manifest } = buildSnapshotFromMemory({
      files: [{ path: 'index.html', content: a.html }],
      name: a.name, branch: 'main', previousSnapshot: null, nowEpochMs: Date.now(),
    });
    const archiveBlob = (await storeBlobAuto(archive)).blobId;
    const manifestBlob = (await storeBlobAuto(JSON.stringify(manifest))).blobId;
    await publishApp(ctx, { name: a.name, prompt: a.prompt, manifestBlob, archiveBlob, treeHash: manifest.treeHash, category: a.category });
    console.log(`  published ${a.name} (tree ${manifest.treeHash.slice(0, 10)}…)`);
    n++;
  } catch (e) { console.error(`  FAILED ${a.name}:`, e.message || e); }
}

// Claim a handle so the portal /@handle profile is populated too (best-effort).
try {
  const tx = new Transaction();
  tx.moveCall({ target: `${ctx.deployment.playgroundPackageId}::playground::claim_name`, arguments: [tx.object(ctx.deployment.nameRegistry), tx.pure.string('seeddemo')] });
  await ctx.client.signAndExecuteTransaction({ signer: ctx.keypair, transaction: tx });
  console.log('  claimed @seeddemo');
} catch (e) { console.log('  handle claim skipped:', e.message || e); }

console.log(`\nseeded ${n}/${APPS.length} apps on ${NET}.`);
