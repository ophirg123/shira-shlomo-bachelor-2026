#!/usr/bin/env node
/**
 * watch.js - Auto-sync daemon: watches both Obsidian files AND Firebase
 * 
 * Usage:
 *   node watch.js              # Run in foreground
 *   node watch.js &            # Run in background
 *   node watch.js --install    # Install as macOS LaunchAgent (auto-start on login)
 *   node watch.js --uninstall  # Remove LaunchAgent
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const OBS_DIR = '/Users/ogruteke/Documents/Obsidian/Life/Events/רווקים_רווקות_שירה_ושלמה_2026';
const SYNC_SCRIPT = path.join(__dirname, 'sync.js');
const FB_URL = 'https://shira-shlomo-2026-default-rtdb.europe-west1.firebasedatabase.app';
const DEBOUNCE_MS = 3000;
const PULL_DEBOUNCE_MS = 5000;

// Track state to avoid loops
let lastPushTime = 0;
let lastPullTime = 0;
let pushTimer = null;
let pullTimer = null;
let lastFbHash = '';
let isPushing = false;
let isPulling = false;

// ─── File Watcher: Obsidian → Firebase ──────────────────────────

const WATCH_FILES = [
  'משימות.md',
  'רשימת_קניות_וציוד.md',
  'השראה_תפריט_על_האש.md',
  'השראה_ארוחת_בוקר.md',
  'חוף_אמנון_זילה_זולה.md',
  'תכנון_אלכוהול.md',
  'לוז_ראשי.md',
];

function startFileWatcher() {
  console.log('👁️  Watching Obsidian files for changes...');
  
  for (const file of WATCH_FILES) {
    const fullPath = path.join(OBS_DIR, file);
    if (!fs.existsSync(fullPath)) continue;
    
    fs.watch(fullPath, (eventType) => {
      if (isPulling) return; // Don't push if we just pulled
      if (Date.now() - lastPullTime < PULL_DEBOUNCE_MS) return; // Avoid push-after-pull loop
      
      // Debounce
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        doPush(file);
      }, DEBOUNCE_MS);
    });
  }
}

async function doPush(triggerFile) {
  if (isPushing) return;
  isPushing = true;
  lastPushTime = Date.now();
  
  console.log(`\n📤 [${time()}] File changed: ${triggerFile} → pushing to Firebase...`);
  try {
    const result = execSync(`node "${SYNC_SCRIPT}" push`, { encoding: 'utf8', timeout: 30000 });
    // Show just the summary lines
    result.split('\n').filter(l => l.includes('✅') || l.includes('pushed')).forEach(l => console.log(`   ${l.trim()}`));
    console.log(`   ✅ Push done`);
  } catch (e) {
    console.error(`   ❌ Push failed: ${e.message}`);
  }
  isPushing = false;
}

// ─── Firebase Listener: Firebase → Obsidian ─────────────────────

function startFirebaseListener() {
  console.log('🔥 Listening to Firebase for changes...');
  pollFirebase();
}

function pollFirebase() {
  // Poll every 10 seconds (SSE/streaming is complex with raw https)
  setInterval(async () => {
    if (isPushing) return; // Don't pull while pushing
    if (Date.now() - lastPushTime < PULL_DEBOUNCE_MS) return; // Avoid pull-after-push loop
    
    try {
      const hash = await getFirebaseHash();
      if (hash && hash !== lastFbHash) {
        if (lastFbHash !== '') { // Skip first poll
          if (pullTimer) clearTimeout(pullTimer);
          pullTimer = setTimeout(() => doPull(), 1000);
        }
        lastFbHash = hash;
      }
    } catch (e) {
      // Silently ignore network errors
    }
  }, 10000);
}

function getFirebaseHash() {
  return new Promise((resolve, reject) => {
    // Get a lightweight hash of Firebase state (just task/shopping/menu counts + modification timestamps)
    https.get(`${FB_URL}/.json?shallow=true`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Also check specific volatile paths
        https.get(`${FB_URL}/tasks.json?shallow=true`, (r2) => {
          let d2 = '';
          r2.on('data', c => d2 += c);
          r2.on('end', () => resolve(data + '|' + d2));
        });
      });
    }).on('error', reject);
  });
}

async function doPull() {
  if (isPulling) return;
  isPulling = true;
  lastPullTime = Date.now();
  
  console.log(`\n📥 [${time()}] Firebase changed → pulling to Obsidian...`);
  try {
    const result = execSync(`node "${SYNC_SCRIPT}" pull`, { encoding: 'utf8', timeout: 30000 });
    result.split('\n').filter(l => l.includes('✅') || l.includes('—')).forEach(l => console.log(`   ${l.trim()}`));
    console.log(`   ✅ Pull done`);
  } catch (e) {
    console.error(`   ❌ Pull failed: ${e.message}`);
  }
  
  // Small delay before allowing pushes again
  setTimeout(() => { isPulling = false; }, DEBOUNCE_MS);
}

// ─── Helpers ────────────────────────────────────────────────────

function time() {
  return new Date().toLocaleTimeString('he-IL');
}

// ─── LaunchAgent (auto-start on login) ──────────────────────────

const PLIST_NAME = 'com.shira-shlomo.sync-watcher';
const PLIST_PATH = path.join(process.env.HOME, 'Library/LaunchAgents', `${PLIST_NAME}.plist`);

function installLaunchAgent() {
  const nodePath = process.execPath;
  const scriptPath = path.resolve(__dirname, 'watch.js');
  const logPath = path.join(process.env.HOME, 'Library/Logs', 'shira-shlomo-sync.log');
  
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>WorkingDirectory</key>
  <string>${__dirname}</string>
</dict>
</plist>`;

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist);
  execSync(`launchctl load "${PLIST_PATH}"`);
  console.log(`✅ Installed LaunchAgent: ${PLIST_NAME}`);
  console.log(`   Log: ${logPath}`);
  console.log(`   Will auto-start on login and keep running.`);
  console.log(`   To stop: node watch.js --uninstall`);
}

function uninstallLaunchAgent() {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
  } catch(e) {}
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
  }
  console.log(`✅ Uninstalled LaunchAgent: ${PLIST_NAME}`);
}

// ─── Main ───────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === '--install') {
  installLaunchAgent();
  process.exit(0);
}

if (arg === '--uninstall') {
  uninstallLaunchAgent();
  process.exit(0);
}

console.log(`
🔄 Shira & Shlomo Sync Watcher
   Obsidian: ${OBS_DIR}
   Firebase: ${FB_URL}
   
   Watching for changes in both directions...
   Press Ctrl+C to stop.
`);

startFileWatcher();
startFirebaseListener();

// Keep alive
process.on('SIGINT', () => {
  console.log('\n👋 Watcher stopped.');
  process.exit(0);
});
