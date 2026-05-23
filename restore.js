#!/usr/bin/env node
/**
 * restore.js - Regenerate ALL Obsidian MD files from Firebase data
 * Run this once to restore files that were lost
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const FB = 'https://shira-shlomo-2026-default-rtdb.europe-west1.firebasedatabase.app';
const OBS = '/Users/ogruteke/Documents/Obsidian/Life/Events/רווקים_רווקות_שירה_ושלמה_2026';

function fbGet(p) {
  return new Promise((res, rej) => {
    https.get(`${FB}${p}.json`, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){res(null)} }); }).on('error',rej);
  });
}

async function restore() {
  console.log('🔄 Restoring ALL Obsidian MD files from Firebase...\n');
  const fb = await fbGet('/');
  if (!fb) { console.log('❌ No data'); return; }

  const taskDefs = fb.taskDefs || {};
  const taskStates = fb.tasks || {};
  const shopDefs = fb.shopDefs || {};
  const shopStates = fb.shopping || {};
  const equipDefs = fb.equipDefs || {};
  const equipStates = fb.equipment || {};
  const menuBbq = fb.menuItems?.bbq || {};
  const menuBr = fb.menuItems?.breakfast || {};
  const prepDefs = fb.prepDefs || {};
  const prepStates = fb.prep || {};
  const decDefs = fb.decisionDefs || {};
  const decStates = fb.decisions || {};
  const packDefs = fb.packingDefs || {};
  const notes = fb.notes || {};

  // ─── 1. משימות.md ───
  const SECTIONS = {
    'urgent': '## 🔴 דחוף - השבוע (עד 25.5)',
    'important': '## 🟠 חשוב - שבוע הבא (עד 1.6)',
    'week-before': '## 🟡 שבוע לפני (1-4.6) - קניות וחלוקה',
    'day-before': '## 🟢 יום-יומיים לפני (3-4.6) - טרי והכנות',
    'friday': '## ⚪ יום האירוע - שישי 5.6',
    'saturday': '## ⚪ יום שבת 6.6',
    'questions': '## שאלות פתוחות',
  };
  let tasksMd = '# 📋 משימות - רווקים/רווקות שירה ושלמה\n\n[← חזרה ללו"ז ראשי](לוז_ראשי.md)\n\n---\n\n';
  const tasksBySection = {};
  Object.values(taskDefs).sort((a,b)=>a.order-b.order).forEach(d => {
    if (!tasksBySection[d.section]) tasksBySection[d.section] = [];
    tasksBySection[d.section].push(d);
  });
  for (const [sec, title] of Object.entries(SECTIONS)) {
    const items = tasksBySection[sec] || [];
    if (items.length === 0) continue;
    tasksMd += `${title}\n\n`;
    for (const d of items) {
      const s = taskStates[d.id] || {};
      const check = s.done ? 'x' : ' ';
      tasksMd += `- [${check}] ${d.text}`;
      if (s.assignee) tasksMd += ` ← **${s.assignee}**`;
      tasksMd += '\n';
      if (notes[d.id]?.text) tasksMd += `\t> 📝 _${notes[d.id].text}_ (${notes[d.id].author||''})\n`;
    }
    tasksMd += '\n---\n\n';
  }
  fs.writeFileSync(path.join(OBS, 'משימות.md'), tasksMd);
  console.log(`📋 משימות.md — ${Object.keys(taskDefs).length} tasks`);

  // ─── 2. רשימת_קניות_וציוד.md ───
  let shopMd = '# 🛒 רשימת קניות וציוד - רווקים/רווקות שירה ושלמה\n\n';
  shopMd += '[← חזרה ללו"ז ראשי](לוז_ראשי.md)\n\n';
  shopMd += '> 📐 ארוחת ערב שישי = 40 איש. ארוחת בוקר שבת = 25 איש.\n\n---\n\n';

  // Equipment section
  shopMd += '# חלק א\' - ציוד\n\n';
  const equipByCat = {};
  Object.values(equipDefs).sort((a,b)=>a.order-b.order).forEach(d => {
    if (!equipByCat[d.cat]) equipByCat[d.cat] = [];
    equipByCat[d.cat].push(d);
  });
  for (const [cat, items] of Object.entries(equipByCat)) {
    shopMd += `## ${cat}\n\n`;
    shopMd += '| פריט | כמות | אחראי | יש? |\n|------|------|--------|-----|\n';
    for (const d of items) {
      const s = equipStates[d.id] || {};
      const name = d.zila ? `~~${d.name}~~` : d.name;
      const assignee = s.assignee || '';
      const status = (s.done || d.zila) ? '✅' : '⬜';
      shopMd += `| ${name} | ${d.qty||''} | ${d.zila ? 'זילה זולה' : assignee} | ${status} |\n`;
    }
    shopMd += '\n';
  }

  // Packing list
  shopMd += '## 👤 ציוד אישי מומלץ\n\n';
  Object.values(packDefs).sort((a,b)=>a.order-b.order).forEach(d => {
    shopMd += `- [ ] ${d.text}\n`;
  });
  shopMd += '\n---\n\n';

  // Shopping section
  shopMd += '# חלק ב\' - רשימת קניות\n\n';
  const shopByDept = {};
  Object.values(shopDefs).sort((a,b)=>a.order-b.order).forEach(d => {
    const dept = d.dept || 'אחר';
    if (!shopByDept[dept]) shopByDept[dept] = [];
    shopByDept[dept].push(d);
  });
  for (const [dept, items] of Object.entries(shopByDept)) {
    shopMd += `## ${dept}\n\n`;
    shopMd += '| פריט | כמות | ל-מה | נקנה? |\n|------|------|------|-------|\n';
    for (const d of items) {
      const s = shopStates[d.id] || {};
      const status = s.done ? '✅' : '⬜';
      shopMd += `| ${d.name} | ${d.qty||''} | ${d.note||''} | ${status} |\n`;
    }
    shopMd += '\n';
  }
  fs.writeFileSync(path.join(OBS, 'רשימת_קניות_וציוד.md'), shopMd);
  console.log(`🛒 רשימת_קניות_וציוד.md — ${Object.keys(shopDefs).length} shopping + ${Object.keys(equipDefs).length} equipment`);

  // ─── 3. השראה_תפריט_על_האש.md ───
  let bbqMd = '# 🔥 השראה - תפריט על האש ברמה גבוהה (בשרי)\n\n';
  bbqMd += '[← חזרה ללו"ז ראשי](לוז_ראשי.md)\n\n> **הכל בשרי/פרווה - ללא חלב.**\n\n---\n\n';
  const bbqByCat = {};
  Object.values(menuBbq).sort((a,b)=>(a.order||0)-(b.order||0)).forEach(i => {
    if (!bbqByCat[i.cat]) bbqByCat[i.cat] = [];
    bbqByCat[i.cat].push(i);
  });
  for (const [cat, items] of Object.entries(bbqByCat)) {
    bbqMd += `## ${cat}\n\n`;
    for (const i of items) {
      bbqMd += `- **${i.name}**${i.desc ? ' ' + i.desc : ''}\n`;
    }
    bbqMd += '\n---\n\n';
  }
  fs.writeFileSync(path.join(OBS, 'השראה_תפריט_על_האש.md'), bbqMd);
  console.log(`🔥 השראה_תפריט_על_האש.md — ${Object.keys(menuBbq).length} items`);

  // ─── 4. השראה_ארוחת_בוקר.md ───
  let brMd = '# 🍳 השראה - ארוחת בוקר שבת (חלבית, 25 איש)\n\n';
  brMd += '[← חזרה ללו"ז ראשי](לוז_ראשי.md)\n\n---\n\n';
  const brByCat = {};
  Object.values(menuBr).sort((a,b)=>(a.order||0)-(b.order||0)).forEach(i => {
    if (!brByCat[i.cat]) brByCat[i.cat] = [];
    brByCat[i.cat].push(i);
  });
  for (const [cat, items] of Object.entries(brByCat)) {
    brMd += `## ${cat}\n\n`;
    for (const i of items) {
      brMd += `- **${i.name}**${i.desc ? ' - ' + i.desc : ''}\n`;
    }
    brMd += '\n';
  }
  // Prep table
  if (Object.keys(prepDefs).length > 0) {
    brMd += '---\n\n## סיכום הכנות מראש בבית\n\n';
    brMd += '| מה | מתי | מי |\n|-----|------|-----|\n';
    Object.values(prepDefs).sort((a,b)=>a.order-b.order).forEach(d => {
      const s = prepStates[d.id] || {};
      brMd += `| ${d.name} | ${d.when||''} | ${s.assignee||''} |\n`;
    });
  }
  fs.writeFileSync(path.join(OBS, 'השראה_ארוחת_בוקר.md'), brMd);
  console.log(`🍳 השראה_ארוחת_בוקר.md — ${Object.keys(menuBr).length} items`);

  // ─── 5. חוף_אמנון_זילה_זולה.md ───
  let decMd = '# 🏖️ חוף אמנון - Zila Zula Events\n\n';
  decMd += '> **טלפון:** 053-4373113\n> **סטטוס:** ✅ נסגר!\n\n---\n\n';
  decMd += '## 🤔 תוספות לשקול\n\n';
  Object.values(decDefs).sort((a,b)=>a.order-b.order).forEach(d => {
    const s = decStates[d.id] || {};
    decMd += `- [${s.selected ? 'x' : ' '}] ${d.text}\n`;
  });
  fs.writeFileSync(path.join(OBS, 'חוף_אמנון_זילה_זולה.md'), decMd);
  console.log(`🏖️ חוף_אמנון_זילה_זולה.md — ${Object.keys(decDefs).length} decisions`);

  // ─── 6. תפריט_סופי.md (generated) ───
  // Use sync.js pull for this
  const { execSync } = require('child_process');
  execSync(`node "${path.join(__dirname, 'sync.js')}" pull`, { encoding: 'utf8', stdio: 'pipe' });
  console.log(`📊 תפריט_סופי.md + סנכרון_מהאפליקציה.md — generated via pull`);

  console.log(`\n✅ All ${fs.readdirSync(OBS).filter(f=>f.endsWith('.md')).length} MD files restored!`);
}

restore().catch(console.error);
