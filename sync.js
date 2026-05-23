#!/usr/bin/env node
/**
 * sync.js - Full bidirectional sync: Obsidian ↔ Firebase ↔ App
 *
 * Usage:
 *   node sync.js status          # Show diff
 *   node sync.js pull            # Firebase → Obsidian (ALL files)
 *   node sync.js push            # Obsidian → Firebase (ALL data)
 *   node sync.js push --force    # Overwrite Firebase menus even if edited in app
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const FB = 'https://shira-shlomo-2026-default-rtdb.europe-west1.firebasedatabase.app';
// Auto-detect: if running from inside Obsidian submodule, parent dir is the event folder
const OBS = fs.existsSync(path.join(__dirname, '..', 'משימות.md'))
  ? path.join(__dirname, '..')
  : '/Users/ogruteke/Documents/Obsidian/Life/Events/רווקים_רווקות_שירה_ושלמה_2026';

// ─── Firebase helpers ────────────────────────────────────────────
function fbGet(p) {
  return new Promise((res, rej) => {
    https.get(`${FB}${p}.json`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){res(null)} }); }).on('error',rej);
  });
}
function fbWrite(method, p, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const u = new URL(`${FB}${p}.json`);
    const req = https.request({ hostname:u.hostname, path:u.pathname, method, headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(d)); });
    req.on('error',rej); req.write(body); req.end();
  });
}
const fbPut = (p,d) => fbWrite('PUT',p,d);
const fbPatch = (p,d) => fbWrite('PATCH',p,d);

function readMd(f) { const p=path.join(OBS,f); return fs.existsSync(p)?fs.readFileSync(p,'utf8'):null; }
function writeMd(f,c) { fs.writeFileSync(path.join(OBS,f),c,'utf8'); }

// ─── Parsers: MD → data ─────────────────────────────────────────

function parseMenuMd(content) {
  const items = []; let cat = ''; let order = 0;
  for (const line of content.split('\n')) {
    // ### subcategory takes priority, ## is top-level section
    const h3 = line.match(/^###\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    if (h3) { cat = h3[1].replace(/^[^\u05d0-\u05ea]+/,'').trim() || h3[1].trim(); continue; }
    if (h2) { cat = h2[1].replace(/^[^\u05d0-\u05ea]+/,'').trim() || h2[1].trim(); continue; }
    // Menu items: - **name** desc  OR  - ✅/❌ **name** desc
    const im = line.match(/^- (?:[✅❌]\s*)?\*\*(.+?)\*\*\s*(.*)/);
    if (im && cat) { items.push({ name:im[1].trim(), desc:im[2].replace(/^[-–—]\s*/,'').trim(), cat, order:order++ }); }
  }
  return items;
}

function parseTasksMd(content) {
  const tasks = []; let section = 'other';
  const sMap = {'דחוף':'urgent','חשוב':'important','שבוע לפני':'week-before','יום-יומיים':'day-before',
    'יום האירוע':'friday','שישי':'friday','שבת':'saturday','שאלות פתוחות':'questions',
    'תפריט':'urgent','החלטות':'urgent','לוגיסטיקה':'important','תקשורת':'important',
    'קניות יבשות':'week-before','חלוקת אחריות':'week-before','קניות טריות':'day-before',
    'הכנות מראש':'day-before','העברה למקרר':'day-before','בדרך':'friday','צוות הקמה':'friday',
    'הגעת כולם':'friday','הכנות מנגל':'friday','מנגל':'friday','אווירה':'friday',
    'קפה ועוגות':'saturday','ארוחת בוקר':'saturday','ים ומשחקים':'saturday','פינוי':'saturday'};
  for (const line of content.split('\n')) {
    const h = line.match(/^##[#]?\s+(.+)/);
    if (h) { const hdr = h[1].replace(/[🔴🟠🟡🟢⚪📋]/g,'').trim(); for (const [k,v] of Object.entries(sMap)) { if (hdr.includes(k)) { section=v; break; } } continue; }
    const tm = line.match(/^- \[([ x])\]\s+(.+)/);
    if (tm) {
      let text = tm[2].replace(/\*\*/g,'').trim();
      let assignee = '';
      const am = text.match(/←\s*\*?\*?(.+?)\*?\*?\s*$/);
      if (am) { assignee = am[1].trim(); text = text.replace(/\s*←.*$/,'').trim(); }
      // Remove trailing note lines
      tasks.push({ text, done: tm[1]==='x', assignee, section });
    }
  }
  return tasks;
}

function parseShoppingTables(content) {
  // Parse ALL shopping tables (Part ב - Shopping). Tables have: | פריט | כמות | ל-מה/note | נקנה?/status |
  const items = []; let dept = ''; let subDept = '';
  const lines = content.split('\n');
  let inShoppingSection = false;
  let tableFormat = ''; // 'shopping' or 'equip'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('חלק ב') || line.includes('רשימת קניות')) inShoppingSection = true;
    if (line.includes('חלק א') || line.includes('ציוד')) inShoppingSection = false;

    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    if (h2) { dept = h2[1].trim(); continue; }
    if (h3) { subDept = h3[1].trim(); continue; }

    // Detect table header to know format
    if (line.includes('| פריט') && line.includes('נקנה')) { tableFormat = 'shopping'; continue; }
    if (line.includes('---')) continue;

    if (tableFormat === 'shopping') {
      const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
      if (m) {
        const name = m[1].replace(/\*\*/g,'').trim();
        const qty = m[2].trim();
        const note = m[3].trim();
        const status = m[4].trim();
        if (!name || name.includes('---') || name === 'פריט') continue;
        items.push({ name, qty, note, done: status==='✅', dept, subDept });
      }
    }
  }
  return items;
}

function parseEquipmentTables(content) {
  // Parse equipment tables (Part א). Tables: | פריט | כמות | אחראי | יש? |
  const items = []; let cat = '';
  let inEquipSection = false;

  for (const line of content.split('\n')) {
    if (line.includes('חלק א') || line.includes('ציוד')) inEquipSection = true;
    if (line.includes('חלק ב') || line.includes('רשימת קניות')) inEquipSection = false;
    if (line.includes('ציוד אישי')) inEquipSection = false; // personal packing is separate

    const h3 = line.match(/^### (.+)/);
    if (h3) { cat = h3[1].trim(); continue; }
    if (!inEquipSection) continue;
    if (line.includes('---') || !line.startsWith('|')) continue;
    if (line.includes('פריט') && line.includes('כמות')) continue; // header

    const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (m) {
      let name = m[1].replace(/~~(.+?)~~/g,'$1').replace(/\*\*/g,'').trim();
      const qty = m[2].replace(/~~(.+?)~~/g,'$1').trim();
      const assignee = m[3].trim();
      const status = m[4].trim();
      if (!name || name === 'פריט') continue;
      const zila = line.includes('זילה זולה') || (line.includes('~~') && status==='✅');
      items.push({ name, qty, assignee, done: status==='✅', cat, zila });
    }
  }
  return items;
}

function parsePackingList(content) {
  const items = [];
  let inPacking = false;
  for (const line of content.split('\n')) {
    if (line.includes('ציוד אישי')) inPacking = true;
    if (inPacking && line.match(/^## [^#]/)) { if (!line.includes('ציוד אישי')) inPacking = false; }
    if (inPacking) {
      const m = line.match(/^- \[([ x])\]\s+(.+)/);
      if (m) items.push({ text: m[2].trim(), done: m[1]==='x' });
    }
  }
  return items;
}

function parseDecisions(content) {
  const items = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^- \[([ x])\]\s+(.+)/);
    if (m) items.push({ text: m[2].trim(), done: m[1]==='x' });
  }
  return items;
}

// ─── PUSH: Obsidian → Firebase ──────────────────────────────────

async function push(force) {
  console.log('📤 PUSH: Obsidian → Firebase (full sync)\n');
  const fb = await fbGet('/') || {};

  // 1. MENUS — read from תפריט_סופי.md (curated) if exists, else from inspiration files
  const finalMenuMd = readMd('תפריט_סופי.md');
  const menuSources = finalMenuMd
    ? [['bbq', null, '🔥 BBQ'], ['breakfast', null, '🍳 Breakfast']]
    : [['bbq','השראה_תפריט_על_האש.md','🔥 BBQ'],['breakfast','השראה_ארוחת_בוקר.md','🍳 Breakfast']];

  // Parse final menu by splitting on the two main headers
  let finalBbqSection = '', finalBreakfastSection = '';
  if (finalMenuMd) {
    const bbqStart = finalMenuMd.indexOf('תפריט על האש');
    const brStart = finalMenuMd.indexOf('ארוחת בוקר');
    if (bbqStart >= 0 && brStart >= 0) {
      finalBbqSection = finalMenuMd.substring(bbqStart, brStart);
      finalBreakfastSection = finalMenuMd.substring(brStart);
    } else if (bbqStart >= 0) {
      finalBbqSection = finalMenuMd.substring(bbqStart);
    }
  }

  for (const [type, file, label] of menuSources) {
    const md = finalMenuMd ? (type === 'bbq' ? finalBbqSection : finalBreakfastSection) : readMd(file);
    if (!md) { console.log(`${label}: no content found`); continue; }
    const existing = fb.menuItems?.[type];
    if (!force && existing && Object.keys(existing).length > 0) {
      console.log(`${label}: Firebase has ${Object.keys(existing).length} items (skipping, use --force)`);
      continue;
    }
    const items = parseMenuMd(md);
    const fbItems = {};
    items.forEach((item, i) => {
      const id = `${type}-${i+1}`;
      fbItems[id] = { id, name:item.name, desc:item.desc, cat:item.cat, order:item.order, selected: existing?.[id]?.selected || false };
    });
    await fbPut(`/menuItems/${type}`, fbItems);
    console.log(`${label}: ✅ ${items.length} items pushed`);
  }

  // 2. TASKS
  console.log('');
  const tasksMd = readMd('משימות.md');
  if (tasksMd) {
    const parsed = parseTasksMd(tasksMd);
    // Store task definitions in Firebase
    const taskDefs = {};
    const taskStates = fb.tasks || {};
    parsed.forEach((t, i) => {
      const id = `t-${i+1}`;
      taskDefs[id] = { id, text: t.text, section: t.section, order: i };
      // Merge state: Obsidian checked wins, Firebase assignee preserved
      const fbState = taskStates[id] || {};
      taskStates[id] = {
        done: t.done || fbState.done || false,
        assignee: fbState.assignee || t.assignee || ''
      };
    });
    await fbPut('/taskDefs', taskDefs);
    await fbPut('/tasks', taskStates);
    console.log(`📋 Tasks: ✅ ${parsed.length} definitions + states pushed`);
  }

  // 3. SHOPPING
  const shopMd = readMd('רשימת_קניות_וציוד.md');
  if (shopMd) {
    const parsed = parseShoppingTables(shopMd);
    const shopDefs = {};
    const shopStates = fb.shopping || {};
    parsed.forEach((item, i) => {
      const id = `s-${i+1}`;
      shopDefs[id] = { id, name:item.name, qty:item.qty, note:item.note, dept:item.dept, subDept:item.subDept||'', order:i };
      const fbState = shopStates[id] || {};
      shopStates[id] = {
        done: item.done || fbState.done || false,
        assignee: fbState.assignee || ''
      };
    });
    await fbPut('/shopDefs', shopDefs);
    await fbPut('/shopping', shopStates);
    console.log(`🛒 Shopping: ✅ ${parsed.length} items pushed`);
  }

  // 4. EQUIPMENT
  if (shopMd) {
    const parsed = parseEquipmentTables(shopMd);
    const equipDefs = {};
    const equipStates = fb.equipment || {};
    parsed.forEach((item, i) => {
      const id = `e-${i+1}`;
      equipDefs[id] = { id, name:item.name, qty:item.qty, cat:item.cat, zila:item.zila||false, order:i };
      const fbState = equipStates[id] || {};
      equipStates[id] = {
        done: item.done || fbState.done || false,
        assignee: fbState.assignee || item.assignee || ''
      };
    });
    await fbPut('/equipDefs', equipDefs);
    await fbPut('/equipment', equipStates);
    console.log(`⚙️ Equipment: ✅ ${parsed.length} items pushed`);
  }

  // 5. PACKING LIST
  if (shopMd) {
    const packing = parsePackingList(shopMd);
    if (packing.length > 0) {
      const packDefs = {};
      packing.forEach((item, i) => { packDefs[`p-${i+1}`] = { id:`p-${i+1}`, text:item.text, order:i }; });
      await fbPut('/packingDefs', packDefs);
      console.log(`👤 Packing: ✅ ${packing.length} items pushed`);
    }
  }

  // 6. DECISIONS
  const decMd = readMd('חוף_אמנון_זילה_זולה.md');
  if (decMd) {
    const decs = parseDecisions(decMd);
    const decDefs = {};
    const decStates = fb.decisions || {};
    decs.forEach((d, i) => {
      const id = `d-${i+1}`;
      decDefs[id] = { id, text:d.text, order:i };
      if (!decStates[id]) decStates[id] = { selected: d.done };
    });
    await fbPut('/decisionDefs', decDefs);
    await fbPut('/decisions', decStates);
    console.log(`🤔 Decisions: ✅ ${decs.length} items pushed`);
  }

  // 7. PREP
  const brMd = readMd('השראה_ארוחת_בוקר.md');
  if (brMd) {
    const lines = brMd.split('\n');
    let inPrep = false; const preps = [];
    for (const line of lines) {
      if (line.includes('סיכום הכנות')) inPrep = true;
      if (inPrep) {
        const m = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
        if (m && !line.includes('---') && !line.includes('מה') && m[1].trim()) {
          preps.push({ name:m[1].trim(), when:m[2].trim(), who:m[3].trim() });
        }
      }
    }
    if (preps.length > 0) {
      const prepDefs = {}; const prepStates = fb.prep || {};
      preps.forEach((p, i) => {
        const id = `prep-${i+1}`;
        prepDefs[id] = { id, name:p.name, when:p.when, order:i };
        if (!prepStates[id]) prepStates[id] = { done:false, assignee:p.who };
      });
      await fbPut('/prepDefs', prepDefs);
      await fbPatch('/prep', prepStates);
      console.log(`👨‍🍳 Prep: ✅ ${preps.length} items pushed`);
    }
  }

  console.log('\n✅ Full push complete!');
}

// ─── PULL: Firebase → Obsidian ──────────────────────────────────

async function pull() {
  console.log('📥 PULL: Firebase → Obsidian (full sync)\n');
  const fb = await fbGet('/');
  if (!fb) { console.log('❌ No data in Firebase.'); return; }
  const notes = fb.notes || {};

  // 1. MENU → תפריט_סופי.md
  const bbq = Object.values(fb.menuItems?.bbq || {}).sort((a,b)=>(a.order||0)-(b.order||0));
  const br = Object.values(fb.menuItems?.breakfast || {}).sort((a,b)=>(a.order||0)-(b.order||0));
  let menuMd = `# 🔥🍳 תפריט סופי - רווקים/רווקות שירה ושלמה\n\n`;
  menuMd += `> 📅 סונכרן: ${new Date().toLocaleString('he-IL')}\n> ✅ = נבחר | ❌ = לא נבחר\n\n`;
  for (const [title, items] of [['🔥 תפריט על האש - שישי ערב',bbq],['🍳 ארוחת בוקר - שבת',br]]) {
    menuMd += `## ${title}\n\n`;
    const cats = {}; items.forEach(i => { if(!cats[i.cat]) cats[i.cat]=[]; cats[i.cat].push(i); });
    for (const [cat, ci] of Object.entries(cats)) {
      menuMd += `### ${cat}\n\n`;
      for (const i of ci) {
        menuMd += `- ${i.selected?'✅':'❌'} **${i.name}**${i.desc?' - '+i.desc:''}\n`;
        if (notes[i.id]?.text) menuMd += `\t> 📝 _${notes[i.id].text}_ (${notes[i.id].author||''})\n`;
      }
      menuMd += '\n';
    }
  }
  // Prep
  const prepDefs = fb.prepDefs || {};
  const prepStates = fb.prep || {};
  if (Object.keys(prepDefs).length > 0) {
    menuMd += `## 👨‍🍳 הכנות מראש\n\n| מה | מתי | מי מכין | מוכן? |\n|-----|------|--------|------|\n`;
    Object.values(prepDefs).sort((a,b)=>(a.order||0)-(b.order||0)).forEach(d => {
      const s = prepStates[d.id] || {};
      menuMd += `| ${d.name} | ${d.when||''} | ${s.assignee||''} | ${s.done?'✅':'⬜'} |\n`;
    });
  }
  writeMd('תפריט_סופי.md', menuMd);
  console.log(`🔥 תפריט_סופי.md — ${bbq.length} BBQ + ${br.length} breakfast`);

  // 2. TASKS → update משימות.md checkboxes + assignees + notes
  const taskStates = fb.tasks || {};
  const taskDefs = fb.taskDefs || {};
  const origTasks = readMd('משימות.md');
  if (origTasks) {
    let updated = origTasks;
    // For each task with state, find and update in the MD
    for (const [id, state] of Object.entries(taskStates)) {
      const def = taskDefs[id];
      if (!def) continue;
      const text = def.text;
      // Escape for regex
      const esc = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').substring(0, 30);
      if (!esc) continue;
      // Match the line with this task text
      const lineRegex = new RegExp(`^(- \\[)[ x](\\]\\s+(?:\\*\\*)?[^\\n]*${esc}[^\\n]*)`, 'gm');
      updated = updated.replace(lineRegex, (match, prefix, rest) => {
        // Remove old assignee
        let cleanRest = rest.replace(/\s*←\s*\*?\*?[^*\n]+\*?\*?\s*$/, '');
        const check = state.done ? 'x' : ' ';
        let newLine = `${prefix}${check}${cleanRest}`;
        if (state.assignee) newLine += ` ← **${state.assignee}**`;
        return newLine;
      });
      // Add note after the task line if exists
      const noteText = notes[id]?.text;
      if (noteText && !updated.includes(noteText)) {
        const noteLine = `\t> 📝 _${noteText}_ (${notes[id].author||''})`;
        updated = updated.replace(new RegExp(`(- \\[.\\][^\\n]*${esc}[^\\n]*)`,'m'), `$1\n${noteLine}`);
      }
    }
    writeMd('משימות.md', updated);
    const checked = (updated.match(/- \[x\]/g)||[]).length;
    console.log(`📋 משימות.md — ${checked} checked, ${Object.values(taskStates).filter(t=>t.assignee).length} assigned`);
  }

  // 3. SHOPPING → update רשימת_קניות_וציוד.md
  const shopStates = fb.shopping || {};
  const shopDefs = fb.shopDefs || {};
  const origShop = readMd('רשימת_קניות_וציוד.md');
  if (origShop && Object.keys(shopStates).length > 0) {
    let updated = origShop;
    for (const [id, state] of Object.entries(shopStates)) {
      const def = shopDefs[id];
      if (!def || !state.done) continue;
      const esc = def.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').substring(0,20);
      if (!esc) continue;
      // Replace ⬜ with ✅ on lines containing this item
      updated = updated.replace(new RegExp(`(\\|[^|]*${esc}[^|]*(?:\\|[^|]*){2}\\|\\s*)⬜(\\s*\\|)`,'m'), '$1✅$2');
      // Add assignee in the assignee column if available
      if (state.assignee) {
        const assignRegex = new RegExp(`(\\|[^|]*${esc}[^|]*\\|[^|]*\\|)([^|]*)(\\|[^|]*\\|)`,'m');
        // Only update if currently empty
        updated = updated.replace(assignRegex, (match, pre, assignCol, post) => {
          if (assignCol.trim() === '') return `${pre} ${state.assignee} ${post}`;
          return match;
        });
      }
    }
    writeMd('רשימת_קניות_וציוד.md', updated);
    const bought = Object.values(shopStates).filter(s=>s.done).length;
    console.log(`🛒 רשימת_קניות_וציוד.md — ${bought} items bought, ${Object.values(shopStates).filter(s=>s.assignee).length} assigned`);
  } else {
    console.log(`🛒 רשימת_קניות_וציוד.md — no shopping changes yet`);
  }

  // 4. EQUIPMENT → update in same file
  const equipStates = fb.equipment || {};
  const equipDefs = fb.equipDefs || {};
  if (Object.keys(equipStates).length > 0) {
    let updated = readMd('רשימת_קניות_וציוד.md') || origShop;
    for (const [id, state] of Object.entries(equipStates)) {
      const def = equipDefs[id];
      if (!def || def.zila) continue;
      const esc = def.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').substring(0,20);
      if (!esc) continue;
      if (state.done) {
        updated = updated.replace(new RegExp(`(\\|[^|]*${esc}[^|]*(?:\\|[^|]*){2}\\|\\s*)⬜(\\s*\\|)`,'m'), '$1✅$2');
      }
      if (state.assignee) {
        const assignRegex = new RegExp(`(\\|[^|]*${esc}[^|]*\\|[^|]*\\|)([^|]*)(\\|[^|]*\\|)`,'m');
        updated = updated.replace(assignRegex, (match, pre, assignCol, post) => {
          if (assignCol.trim() === '' || assignCol.trim() === '?') return `${pre} ${state.assignee} ${post}`;
          return match;
        });
      }
    }
    writeMd('רשימת_קניות_וציוד.md', updated);
    const equipped = Object.values(equipStates).filter(e=>e.done && !equipDefs[Object.keys(equipStates).find(k=>equipStates[k]===e)]?.zila).length;
    console.log(`⚙️ רשימת_קניות_וציוד.md — equipment updated`);
  }

  // 5. DECISIONS → update חוף_אמנון_זילה_זולה.md
  const decStates = fb.decisions || {};
  const decDefs = fb.decisionDefs || {};
  const origDec = readMd('חוף_אמנון_זילה_זולה.md');
  if (origDec && Object.keys(decStates).length > 0) {
    let updated = origDec;
    for (const [id, state] of Object.entries(decStates)) {
      const def = decDefs[id];
      if (!def) continue;
      const esc = def.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').substring(0,25);
      if (state.selected) {
        updated = updated.replace(new RegExp(`- \\[ \\] ${esc}`,'m'), `- [x] ${def.text}`);
      }
    }
    writeMd('חוף_אמנון_זילה_זולה.md', updated);
    console.log(`🤔 חוף_אמנון_זילה_זולה.md — decisions updated`);
  }

  // 6. SYNC REPORT
  let report = `# 📊 סנכרון מהאפליקציה\n\n> 📅 ${new Date().toLocaleString('he-IL')}\n\n`;

  // Tasks summary
  const tasksActive = Object.entries(taskStates).filter(([,t])=>t.done||t.assignee);
  if (tasksActive.length > 0) {
    report += `## ✅ משימות\n\n`;
    for (const [id,t] of tasksActive) {
      const def = taskDefs[id]; if (!def) continue;
      report += `- [${t.done?'x':' '}] ${def.text}${t.assignee?' ← **'+t.assignee+'**':''}\n`;
      if (notes[id]?.text) report += `\t> 📝 _${notes[id].text}_\n`;
    }
  }

  // Shopping summary
  const shopActive = Object.entries(shopStates).filter(([,s])=>s.done||s.assignee);
  if (shopActive.length > 0) {
    report += `\n## 🛒 קניות\n\n`;
    for (const [id,s] of shopActive) {
      const def = shopDefs[id]; if (!def) continue;
      report += `- [${s.done?'x':' '}] ${def.name} (${def.qty})${s.assignee?' ← **'+s.assignee+'**':''}\n`;
    }
  }

  // Equipment
  const eqActive = Object.entries(equipStates).filter(([,e])=>e.assignee && !equipDefs[Object.keys(equipStates).find(k=>equipStates[k]===e)]?.zila);
  if (eqActive.length > 0) {
    report += `\n## ⚙️ ציוד\n\n`;
    for (const [id,e] of eqActive) {
      const def = equipDefs[id]; if (!def || def.zila) continue;
      report += `- [${e.done?'x':' '}] ${def.name}${e.assignee?' ← **'+e.assignee+'**':''}\n`;
    }
  }

  // Notes
  if (Object.keys(notes).length > 0) {
    report += `\n## 📝 הערות\n\n`;
    for (const [id,n] of Object.entries(notes)) {
      report += `- **${id}**: ${n.text} _(${n.author||'?'})_\n`;
    }
  }

  writeMd('סנכרון_מהאפליקציה.md', report);
  console.log(`📊 סנכרון_מהאפליקציה.md — generated`);

  console.log('\n✅ Full pull complete!');
}

// ─── STATUS ─────────────────────────────────────────────────────

async function status() {
  console.log('📡 Status: Obsidian vs Firebase\n');
  const fb = await fbGet('/') || {};

  const fbBbq = Object.values(fb.menuItems?.bbq||{});
  const fbBr = Object.values(fb.menuItems?.breakfast||{});
  const obsBbq = parseMenuMd(readMd('השראה_תפריט_על_האש.md')||'');
  const obsBr = parseMenuMd(readMd('השראה_ארוחת_בוקר.md')||'');

  console.log(`🔥 BBQ:       Obsidian ${obsBbq.length} items | Firebase ${fbBbq.length} items (${fbBbq.filter(i=>i.selected).length} selected)${fbBbq.length!==obsBbq.length?' ⚠️':' ✅'}`);
  console.log(`🍳 Breakfast: Obsidian ${obsBr.length} items | Firebase ${fbBr.length} items (${fbBr.filter(i=>i.selected).length} selected)`);

  const obsTasks = parseTasksMd(readMd('משימות.md')||'');
  const fbTasks = Object.values(fb.tasks||{});
  const fbTaskDefs = Object.values(fb.taskDefs||{});
  console.log(`📋 Tasks:     Obsidian ${obsTasks.length} (${obsTasks.filter(t=>t.done).length}✓) | Firebase ${fbTaskDefs.length} defs, ${fbTasks.filter(t=>t.done).length}✓, ${fbTasks.filter(t=>t.assignee).length} assigned`);

  const obsShop = parseShoppingTables(readMd('רשימת_קניות_וציוד.md')||'');
  const fbShop = Object.values(fb.shopping||{});
  const fbShopDefs = Object.values(fb.shopDefs||{});
  console.log(`🛒 Shopping:  Obsidian ${obsShop.length} items | Firebase ${fbShopDefs.length} defs, ${fbShop.filter(s=>s.done).length}✓, ${fbShop.filter(s=>s.assignee).length} assigned`);

  const obsEquip = parseEquipmentTables(readMd('רשימת_קניות_וציוד.md')||'');
  const fbEquip = Object.values(fb.equipment||{});
  const fbEquipDefs = Object.values(fb.equipDefs||{});
  console.log(`⚙️ Equipment: Obsidian ${obsEquip.length} items | Firebase ${fbEquipDefs.length} defs, ${fbEquip.filter(e=>e.assignee).length} assigned`);

  console.log(`📝 Notes:     ${Object.keys(fb.notes||{}).length}`);
  console.log(`👨‍🍳 Prep:      ${Object.keys(fb.prepDefs||{}).length} defs, ${Object.values(fb.prep||{}).filter(p=>p.assignee).length} assigned`);
  console.log(`🤔 Decisions: ${Object.values(fb.decisions||{}).filter(d=>d.selected).length}/${Object.keys(fb.decisions||{}).length} approved`);
}

// ─── CLI ─────────────────────────────────────────────────────────
const cmd = process.argv[2] || 'status';
const force = process.argv.includes('--force');

switch(cmd) {
  case 'pull': pull().catch(console.error); break;
  case 'push': push(force).catch(console.error); break;
  case 'status': status().catch(console.error); break;
  default: console.log(`
📦 sync.js — Full bidirectional sync: Obsidian ↔ Firebase ↔ App

  node sync.js status          Show differences
  node sync.js pull            Firebase → Obsidian (update ALL md files)
  node sync.js push            Obsidian → Firebase (push ALL data)
  node sync.js push --force    Also overwrite Firebase menus
`);
}
