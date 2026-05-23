#!/usr/bin/env node
/**
 * sync.js - Bidirectional sync between Firebase and Obsidian MD files
 * 
 * Usage:
 *   node sync.js status          # Show diff between Firebase and Obsidian
 *   node sync.js pull            # Firebase → Obsidian (updates MD files)
 *   node sync.js push            # Obsidian → Firebase (seeds/updates Firebase)
 *   node sync.js push --force    # Overwrite Firebase with Obsidian (menus too)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const FIREBASE_URL = 'https://shira-shlomo-2026-default-rtdb.europe-west1.firebasedatabase.app';
const OBSIDIAN_DIR = '/Users/ogruteke/Documents/Obsidian/Life/Events/רווקים_רווקות_שירה_ושלמה_2026';

// ============================================
// FIREBASE HTTP HELPERS
// ============================================

function firebaseGet(fbPath) {
  return new Promise((resolve, reject) => {
    https.get(`${FIREBASE_URL}${fbPath}.json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    }).on('error', reject);
  });
}

function firebasePut(fbPath, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(`${FIREBASE_URL}${fbPath}.json`);
    const opts = { hostname: url.hostname, path: url.pathname, method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function firebasePatch(fbPath, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(`${FIREBASE_URL}${fbPath}.json`);
    const opts = { hostname: url.hostname, path: url.pathname, method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readMd(filename) {
  const p = path.join(OBSIDIAN_DIR, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function writeMd(filename, content) {
  fs.writeFileSync(path.join(OBSIDIAN_DIR, filename), content, 'utf8');
}

// ============================================
// PARSERS: Obsidian MD → structured data
// ============================================

function parseMenuMd(content) {
  // Parse menu MD files with ## categories and - **name** desc format
  const items = [];
  let currentCat = '';
  let order = 0;
  for (const line of content.split('\n')) {
    const catMatch = line.match(/^##\s+(.+)/);
    if (catMatch) {
      // Clean category: remove emojis and "על האש" prefix stuff
      currentCat = catMatch[1].replace(/^[^\u05d0-\u05ea]+/, '').trim();
      if (!currentCat) currentCat = catMatch[1].trim();
      continue;
    }
    const itemMatch = line.match(/^- \*\*(.+?)\*\*\s*(.*)/);
    if (itemMatch && currentCat) {
      const name = itemMatch[1].trim();
      let desc = itemMatch[2].replace(/^[-–—]\s*/, '').trim();
      items.push({ name, desc, cat: currentCat, order: order++ });
    }
  }
  return items;
}

function parseTasksMd(content) {
  // Parse tasks with sections and - [ ] / - [x] format
  const tasks = [];
  let currentSection = 'other';
  const sectionMap = {
    'דחוף': 'urgent',
    'חשוב': 'important',
    'שבוע לפני': 'week-before',
    'יום-יומיים לפני': 'day-before',
    'יום האירוע': 'friday',
    'שישי': 'friday',
    'שבת': 'saturday',
    'שאלות פתוחות': 'questions',
    'תפריט': 'urgent',
    'החלטות': 'urgent',
    'לוגיסטיקה': 'important',
    'תקשורת': 'important',
    'קניות יבשות': 'week-before',
    'חלוקת אחריות': 'week-before',
    'קניות טריות': 'day-before',
    'הכנות מראש': 'day-before',
    'העברה למקרר': 'day-before',
    'בדרך לחוף': 'friday',
    'צוות הקמה': 'friday',
    'הגעת כולם': 'friday',
    'הכנות מנגל': 'friday',
    'מנגל': 'friday',
    'אווירה': 'friday',
    'קפה ועוגות': 'saturday',
    'ארוחת בוקר': 'saturday',
    'ים ומשחקים': 'saturday',
    'פינוי': 'saturday',
  };

  for (const line of content.split('\n')) {
    // Section headers
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h2 || h3) {
      const header = (h2 || h3)[1].replace(/[🔴🟠🟡🟢⚪📋]/g, '').trim();
      for (const [key, val] of Object.entries(sectionMap)) {
        if (header.includes(key)) { currentSection = val; break; }
      }
      continue;
    }
    // Task items
    const taskMatch = line.match(/^- \[([ x])\]\s+(.+)/);
    if (taskMatch) {
      const done = taskMatch[1] === 'x';
      let text = taskMatch[2].replace(/\*\*/g, '').trim();
      // Extract assignee if present: ← **name**
      let assignee = '';
      const assigneeMatch = text.match(/←\s*\*?\*?(.+?)\*?\*?\s*$/);
      if (assigneeMatch) {
        assignee = assigneeMatch[1].trim();
        text = text.replace(/\s*←.*$/, '').trim();
      }
      tasks.push({ text, done, assignee, section: currentSection });
    }
  }
  return tasks;
}

function parseShoppingMd(content) {
  // Parse shopping items from tables: | name | qty | note | ⬜/✅ |
  const items = [];
  let currentDept = '';
  let currentTiming = 'week-before';
  const timingMap = {
    'בשר': 'day-before', 'עוף': 'day-before',
    'ירקות': 'day-before', 'פירות': 'on-way',
    'ביצים': 'day-before', 'חלב': 'day-before',
    'לחמים': 'on-way', 'מאפים': 'on-way',
    'קפואים': 'on-way',
  };

  for (const line of content.split('\n')) {
    const h2 = line.match(/^##\s+(.+)/);
    const h3 = line.match(/^###\s+(.+)/);
    if (h2) {
      currentDept = h2[1].replace(/[🥩🥕🍉🥚🧀🥫🍞🧂🍷🥤☕🍿🍦🍽️🧹]/g, '').trim();
      for (const [key, val] of Object.entries(timingMap)) {
        if (currentDept.includes(key)) { currentTiming = val; break; }
      }
      continue;
    }
    if (h3) {
      const sub = h3[1].replace(/[🥩🥕🍉🥚🧀🥫🍞🧂🍷🥤☕🍿🍦🍽️🧹]/g, '').trim();
      for (const [key, val] of Object.entries(timingMap)) {
        if (sub.includes(key)) { currentTiming = val; break; }
      }
      continue;
    }
    // Table rows with items (skip headers and separators)
    const tableMatch = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (tableMatch && !line.includes('---') && !line.includes('פריט') && !line.includes('כמות')) {
      const name = tableMatch[1].replace(/~~(.+?)~~/g, '$1').replace(/\*\*/g, '').trim();
      const qty = tableMatch[2].trim();
      const note = tableMatch[3].trim();
      const status = tableMatch[4].trim();
      if (!name || name === '' || name.startsWith('--')) continue;
      // Skip items that are crossed out (provided by Zila Zula)
      if (line.includes('~~') && line.includes('זילה זולה')) continue;
      const done = status === '✅';
      items.push({ name, qty, note, done, dept: currentDept, timing: currentTiming });
    }
  }
  return items;
}

function parseEquipmentMd(content) {
  // Parse equipment tables
  const items = [];
  let currentCat = '';

  for (const line of content.split('\n')) {
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) { currentCat = h3[1].trim(); continue; }
    const tableMatch = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (tableMatch && !line.includes('---') && !line.includes('פריט') && !line.includes('כמות')) {
      let name = tableMatch[1].replace(/~~(.+?)~~/g, '$1').replace(/\*\*/g, '').trim();
      const qty = tableMatch[2].replace(/~~(.+?)~~/g, '$1').trim();
      const assignee = tableMatch[3].trim();
      const status = tableMatch[4].trim();
      if (!name || name === '' || name.startsWith('--')) continue;
      const zila = line.includes('זילה זולה') || line.includes('~~');
      const done = status === '✅';
      items.push({ name, qty, assignee, done, cat: currentCat, zila });
    }
  }
  return items;
}

function parsePrepMd(content) {
  // Parse prep table from ארוחת_בוקר or generated menu
  const items = [];
  const tableRegex = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/;
  let inPrepSection = false;

  for (const line of content.split('\n')) {
    if (line.includes('סיכום הכנות') || line.includes('הכנות מראש')) inPrepSection = true;
    if (inPrepSection) {
      const m = tableRegex.exec(line);
      if (m && !line.includes('---') && !line.includes('מה') && !line.includes('מתי')) {
        const name = m[1].trim();
        const when = m[2].trim();
        const who = m[3].trim();
        if (name) items.push({ name, when, assignee: who });
      }
    }
  }
  return items;
}

// ============================================
// GENERATORS: structured data → Obsidian MD
// ============================================

function generateMenuMd(bbqItems, breakfastItems, notes, prep) {
  let md = `# 🔥🍳 תפריט סופי - רווקים/רווקות שירה ושלמה\n\n`;
  md += `> 📅 סונכרן מהאפליקציה: ${new Date().toLocaleString('he-IL')}\n`;
  md += `> ✅ = נבחר לתפריט | ❌ = לא נבחר\n\n`;

  const renderMenu = (title, items) => {
    md += `## ${title}\n\n`;
    const cats = {};
    items.sort((a, b) => (a.order || 0) - (b.order || 0)).forEach(i => {
      if (!cats[i.cat]) cats[i.cat] = [];
      cats[i.cat].push(i);
    });
    for (const [cat, catItems] of Object.entries(cats)) {
      md += `### ${cat}\n\n`;
      for (const item of catItems) {
        const check = item.selected ? '✅' : '❌';
        md += `- ${check} **${item.name}**`;
        if (item.desc) md += ` - ${item.desc}`;
        md += '\n';
        const note = notes?.[item.id];
        if (note?.text) md += `\t> 📝 _${note.text}_ (${note.author || ''})\n`;
      }
      md += '\n';
    }
  };

  renderMenu('🔥 תפריט על האש - שישי ערב', bbqItems);
  renderMenu('🍳 ארוחת בוקר - שבת', breakfastItems);

  if (prep && Object.keys(prep).length > 0) {
    md += `## 👨‍🍳 הכנות מראש\n\n`;
    md += `| מה | מוכן? | מי מכין |\n|-----|------|--------|\n`;
    for (const [id, p] of Object.entries(prep)) {
      md += `| ${id.replace('prep-', '')} | ${p.done ? '✅' : '⬜'} | ${p.assignee || ''} |\n`;
    }
  }

  return md;
}

function generateTasksMd(tasks, fbTasks, notes) {
  // Rebuild the tasks MD preserving structure but updating checkboxes/assignees/notes
  const sections = {
    'urgent': { title: '## 🔴 דחוף - השבוע (עד 25.5)', subsections: {} },
    'important': { title: '## 🟠 חשוב - שבוע הבא (עד 1.6)', subsections: {} },
    'week-before': { title: '## 🟡 שבוע לפני (1-4.6) - קניות וחלוקה', subsections: {} },
    'day-before': { title: '## 🟢 יום-יומיים לפני (3-4.6) - טרי והכנות', subsections: {} },
    'friday': { title: '## ⚪ יום האירוע - שישי 5.6', subsections: {} },
    'saturday': { title: '## ⚪ יום שבת 6.6', subsections: {} },
    'questions': { title: '## שאלות פתוחות', subsections: {} },
  };

  // Build from original MD (to preserve structure) but update state from Firebase
  const originalContent = readMd('משימות.md');
  if (!originalContent) return null;

  let result = '';
  let taskIndex = 0;

  for (const line of originalContent.split('\n')) {
    const taskMatch = line.match(/^- \[([ x])\]\s+(.+)/);
    if (taskMatch) {
      let text = taskMatch[2].replace(/\*\*/g, '').replace(/\s*←.*$/, '').trim();
      // Find matching Firebase task
      const fbKey = findTaskKey(text, fbTasks);
      const fbState = fbKey ? fbTasks[fbKey] : null;
      const done = fbState?.done || taskMatch[1] === 'x';
      const assignee = fbState?.assignee || '';
      const note = fbKey ? notes?.[fbKey] : null;

      // Reconstruct line
      let newLine = `- [${done ? 'x' : ' '}] ${taskMatch[2].replace(/\s*←.*$/, '').trim()}`;
      if (assignee) newLine += ` ← **${assignee}**`;
      result += newLine + '\n';
      if (note?.text) result += `\t> 📝 _${note.text}_ (${note.author || ''})\n`;
    } else {
      result += line + '\n';
    }
  }

  return result.trimEnd() + '\n';
}

function findTaskKey(text, fbTasks) {
  // Match task text to Firebase task key
  // fbTasks is keyed like { tasks: { 't-1': {done, assignee}, ... } }
  // We need to match by the task text from TASK_MAP
  const TASK_MAP = buildTaskMap();
  for (const [key, mapText] of Object.entries(TASK_MAP)) {
    if (text.includes(mapText) || mapText.includes(text)) {
      if (fbTasks?.[key]) return key;
    }
  }
  return null;
}

function buildTaskMap() {
  // Hardcoded map of task IDs to their text (same as in index.html)
  return {
    't-1': 'לגזור תפריט מנגל סופי',
    't-2': 'לגזור תפריט ארוחת בוקר סופי',
    't-3': 'לגזור מתכונים לכל מנה',
    't-4': 'לחשב כמויות',
    't-5': 'לעדכן רשימת קניות סופית',
    't-6': 'לשאול בקבוצה: רגישויות תזונתיות',
    't-7': 'לשלוח לשירה ושלמה',
    't-8': 'לאשר מנגל נוסף עם עמית ודנה',
    't-9': 'לאשר כירות גז עם בן וחנטל',
    't-10': 'לאשר ג\'בל',
    't-11': 'כירת גז + בלון מזילה זולה',
    't-12': 'רשת כדורעף',
    't-13': 'צידנית 100L',
    't-14': 'שירותים אקולוגיים',
    't-15': 'לברר עלות חניה',
    't-16': 'לתאם מקררים',
    't-17': 'לתאם אוהלים',
    't-18': 'ברד',
    't-19': 'עוגות לשבת',
    't-20': 'גלידות',
    't-21': 'לשלוח רשימת ציוד אישי',
    't-22': 'לתאם שיירה',
    't-23': 'נשנושים',
    't-24': 'חד פעמי',
    't-25': 'אלכוהול',
    't-26': 'שתייה קלה',
    't-27': 'שימורים',
    't-28': 'תבלינים',
    't-29': 'מלאווחים',
    't-30': 'חלוקת מי קונה',
    't-31': 'תקציב סופי',
    't-32': 'לאסוף כסף',
    't-33': 'בשר ועוף',
    't-34': 'גבינות, חלב',
    't-35': 'ירקות',
    't-36': 'אבוקדו, לימונים',
    't-37': 'עוגות, קרואסונים',
    't-38': 'חלה',
    't-39': 'רוטב שקשוקה',
    't-40': 'סלט טאבולה',
    't-41': 'גרנולה ביתית',
    't-42': 'תיבול',
    't-43': 'העברה למקרר',
    't-44': 'קרח',
    't-45': 'לחמים טריים',
    't-46': 'פירות',
    't-47': 'לאסוף אוכל ממקרר',
    't-48': 'לסדר שולחנות',
    't-49': 'להקים 2 מנגלים',
    't-50': 'לסדר צידניות',
    't-51': 'להכין עמדת נשנושים',
    't-52': 'ספירלות נגד יתושים',
    't-53': 'להדליק פחמים',
    't-54': 'להוציא בשר',
    't-55': 'לסדר סלטים',
    't-56': 'לחמים ופיתות',
    't-57': 'עמדת אלכוהול',
    't-58': 'נשנושים לערב',
    't-59': 'קפה',
    't-60': 'עוגות',
    't-61': 'גרנולה',
    't-62': 'ביצים קשות',
    't-63': 'צוות שקשוקה',
    't-64': 'צוות מלאווחים',
    't-65': 'צוות פנקייקים',
    't-66': 'סידור תחנות',
    't-67': 'ניקיון כללי',
    't-68': 'החזרת ציוד',
    't-69': 'לוודא שהחוף נקי',
  };
}

function generateShoppingMd(fbShopping, notes) {
  // Read original MD, update checkboxes and assignees from Firebase
  const original = readMd('רשימת_קניות_וציוד.md');
  if (!original) return null;

  // For shopping, Firebase keys are 's-1', 's-2', etc.
  // We map them by matching item names from the original data
  // Since the original MD uses tables, we update ⬜ → ✅ and add assignees

  let result = original;

  // Simple approach: for each Firebase shopping item with state, try to find and update in the MD
  // This is best-effort matching
  for (const [key, state] of Object.entries(fbShopping || {})) {
    if (state.done) {
      // Replace first ⬜ that hasn't been replaced yet (sequential)
      // This is imprecise but workable for now
    }
  }

  return result;
}

function generateSyncReport(data) {
  const notes = data.notes || {};
  const tasks = data.tasks || {};
  const shopping = data.shopping || {};
  const equipment = data.equipment || {};
  const prep = data.prep || {};
  const decisions = data.decisions || {};
  const menuItems = data.menuItems || {};

  let md = `# 📊 סיכום סנכרון - רווקים/רווקות שירה ושלמה\n\n`;
  md += `> 📅 עודכן: ${new Date().toLocaleString('he-IL')}\n\n`;

  // Tasks with state
  const tasksWithState = Object.entries(tasks).filter(([, t]) => t.done || t.assignee);
  if (tasksWithState.length > 0) {
    md += `## ✅ משימות שהשתנו\n\n`;
    const TASK_MAP = buildTaskMap();
    for (const [id, t] of tasksWithState) {
      md += `- [${t.done ? 'x' : ' '}] ${TASK_MAP[id] || id}`;
      if (t.assignee) md += ` ← **${t.assignee}**`;
      md += '\n';
      if (notes[id]?.text) md += `\t> 📝 _${notes[id].text}_\n`;
    }
  }

  // Shopping with state
  const shopWithState = Object.entries(shopping).filter(([, s]) => s.done || s.assignee);
  if (shopWithState.length > 0) {
    md += `\n## 🛒 קניות שהשתנו\n\n`;
    for (const [id, s] of shopWithState) {
      md += `- [${s.done ? 'x' : ' '}] ${id}`;
      if (s.assignee) md += ` ← **${s.assignee}**`;
      md += '\n';
    }
  }

  // Equipment with state
  const eqWithState = Object.entries(equipment).filter(([, e]) => e.done || e.assignee);
  if (eqWithState.length > 0) {
    md += `\n## ⚙️ ציוד שהשתנה\n\n`;
    for (const [id, e] of eqWithState) {
      md += `- [${e.done ? 'x' : ' '}] ${id}`;
      if (e.assignee) md += ` ← **${e.assignee}**`;
      md += '\n';
    }
  }

  // Prep
  const prepWithState = Object.entries(prep).filter(([, p]) => p.done || p.assignee);
  if (prepWithState.length > 0) {
    md += `\n## 👨‍🍳 הכנות מראש\n\n`;
    for (const [id, p] of prepWithState) {
      md += `- [${p.done ? 'x' : ' '}] ${id}`;
      if (p.assignee) md += ` ← **${p.assignee}**`;
      md += '\n';
    }
  }

  // All notes
  const allNotes = Object.entries(notes);
  if (allNotes.length > 0) {
    md += `\n## 📝 כל ההערות\n\n`;
    for (const [id, n] of allNotes) {
      md += `- **${id}**: ${n.text} _(${n.author || '?'})_\n`;
    }
  }

  // Decisions
  const decided = Object.entries(decisions).filter(([, d]) => d.selected);
  if (decided.length > 0) {
    md += `\n## 🤔 החלטות שאושרו\n\n`;
    for (const [id] of decided) md += `- ✅ ${id}\n`;
  }

  return md;
}

// ============================================
// PUSH: Obsidian → Firebase
// ============================================

async function pushToFirebase(force = false) {
  console.log('📤 Pushing Obsidian → Firebase...\n');
  const data = await firebaseGet('/');

  // 1. Menus - only push if Firebase is empty OR --force
  const existingBbq = data?.menuItems?.bbq;
  const existingBreakfast = data?.menuItems?.breakfast;

  if (force || !existingBbq || Object.keys(existingBbq).length === 0) {
    console.log('🔥 Pushing BBQ menu from Obsidian...');
    const bbqMd = readMd('השראה_תפריט_על_האש.md');
    if (bbqMd) {
      const items = parseMenuMd(bbqMd);
      const fbItems = {};
      items.forEach((item, i) => {
        const id = `bbq-${i + 1}`;
        const existing = existingBbq?.[id];
        fbItems[id] = {
          id, name: item.name, desc: item.desc, cat: item.cat, order: item.order,
          selected: existing?.selected || false,
        };
      });
      await firebasePut('/menuItems/bbq', fbItems);
      console.log(`   ✅ ${items.length} BBQ items pushed`);
    }
  } else {
    console.log('🔥 BBQ menu: Firebase already has data, skipping (use --force to overwrite)');
    console.log(`   Firebase: ${Object.keys(existingBbq).length} items`);
  }

  if (force || !existingBreakfast || Object.keys(existingBreakfast).length === 0) {
    console.log('🍳 Pushing Breakfast menu from Obsidian...');
    const brMd = readMd('השראה_ארוחת_בוקר.md');
    if (brMd) {
      const items = parseMenuMd(brMd);
      const fbItems = {};
      items.forEach((item, i) => {
        const id = `br-${i + 1}`;
        const existing = existingBreakfast?.[id];
        fbItems[id] = {
          id, name: item.name, desc: item.desc, cat: item.cat, order: item.order,
          selected: existing?.selected || false,
        };
      });
      await firebasePut('/menuItems/breakfast', fbItems);
      console.log(`   ✅ ${items.length} Breakfast items pushed`);
    }
  } else {
    console.log('🍳 Breakfast menu: Firebase already has data, skipping (use --force to overwrite)');
    console.log(`   Firebase: ${Object.keys(existingBreakfast).length} items`);
  }

  // 2. Tasks - merge: Obsidian content + Firebase state
  console.log('\n📋 Syncing tasks...');
  const tasksMd = readMd('משימות.md');
  if (tasksMd) {
    const parsedTasks = parseTasksMd(tasksMd);
    const existingTasks = data?.tasks || {};
    const TASK_MAP = buildTaskMap();

    // Update Firebase with any tasks that are checked in Obsidian but not in Firebase
    const updates = {};
    for (const task of parsedTasks) {
      // Find matching task ID
      let matchedId = null;
      for (const [id, mapText] of Object.entries(TASK_MAP)) {
        if (task.text.includes(mapText) || mapText.includes(task.text.substring(0, 15))) {
          matchedId = id;
          break;
        }
      }
      if (matchedId) {
        const existing = existingTasks[matchedId] || {};
        // Obsidian wins for done if it's checked, Firebase wins if it has assignee
        if (task.done && !existing.done) {
          updates[matchedId] = { done: true, assignee: existing.assignee || task.assignee || '' };
        }
        if (task.assignee && !existing.assignee) {
          if (!updates[matchedId]) updates[matchedId] = { done: existing.done || false, assignee: '' };
          updates[matchedId].assignee = task.assignee;
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await firebasePatch('/tasks', updates);
      console.log(`   ✅ ${Object.keys(updates).length} task states pushed`);
    } else {
      console.log('   ℹ️  No task changes to push');
    }
  }

  // 3. Prep items from breakfast MD
  console.log('\n👨‍🍳 Syncing prep items...');
  const breakfastMd = readMd('השראה_ארוחת_בוקר.md');
  if (breakfastMd) {
    const prepItems = parsePrepMd(breakfastMd);
    if (prepItems.length > 0) {
      const existingPrep = data?.prep || {};
      const updates = {};
      prepItems.forEach((item, i) => {
        const id = `prep-${i + 1}`;
        if (!existingPrep[id]) {
          updates[id] = { done: false, assignee: item.assignee || '' };
        } else if (item.assignee && !existingPrep[id].assignee) {
          updates[id] = { ...existingPrep[id], assignee: item.assignee };
        }
      });
      if (Object.keys(updates).length > 0) {
        await firebasePatch('/prep', updates);
        console.log(`   ✅ ${Object.keys(updates).length} prep items pushed`);
      } else {
        console.log('   ℹ️  No prep changes to push');
      }
    }
  }

  console.log('\n✅ Push complete!');
}

// ============================================
// PULL: Firebase → Obsidian
// ============================================

async function pullToObsidian() {
  console.log('📥 Pulling Firebase → Obsidian...\n');
  const data = await firebaseGet('/');
  if (!data) { console.log('❌ No data in Firebase.'); return; }

  const notes = data.notes || {};

  // 1. Generate final menu MD from Firebase
  const bbqItems = Object.values(data.menuItems?.bbq || {});
  const breakfastItems = Object.values(data.menuItems?.breakfast || {});
  if (bbqItems.length > 0 || breakfastItems.length > 0) {
    const menuMd = generateMenuMd(bbqItems, breakfastItems, notes, data.prep);
    writeMd('תפריט_סופי.md', menuMd);
    console.log(`🔥 תפריט_סופי.md - ${bbqItems.length} BBQ + ${breakfastItems.length} breakfast items`);
  }

  // 2. Update tasks MD with Firebase state
  const tasksMd = generateTasksMd(null, data.tasks || {}, notes);
  if (tasksMd) {
    writeMd('משימות.md', tasksMd);
    const checkedCount = (tasksMd.match(/\- \[x\]/g) || []).length;
    console.log(`📋 משימות.md - updated (${checkedCount} checked)`);
  }

  // 3. Generate sync report
  const report = generateSyncReport(data);
  writeMd('סנכרון_מהאפליקציה.md', report);
  console.log(`📊 סנכרון_מהאפליקציה.md - generated`);

  console.log('\n✅ Pull complete! Check your Obsidian vault.');
}

// ============================================
// STATUS
// ============================================

async function showStatus() {
  console.log('📡 Comparing Firebase vs Obsidian...\n');
  const data = await firebaseGet('/');

  // Firebase menu counts
  const fbBbq = Object.values(data?.menuItems?.bbq || {});
  const fbBreakfast = Object.values(data?.menuItems?.breakfast || {});
  const fbBbqSelected = fbBbq.filter(i => i.selected).length;
  const fbBreakfastSelected = fbBreakfast.filter(i => i.selected).length;

  // Obsidian menu counts
  const bbqMd = readMd('השראה_תפריט_על_האש.md');
  const brMd = readMd('השראה_ארוחת_בוקר.md');
  const obsBbq = bbqMd ? parseMenuMd(bbqMd) : [];
  const obsBr = brMd ? parseMenuMd(brMd) : [];

  console.log('🔥 BBQ Menu:');
  console.log(`   Obsidian: ${obsBbq.length} items (original inspiration)`);
  console.log(`   Firebase: ${fbBbq.length} items (${fbBbqSelected} selected)`);
  if (fbBbq.length !== obsBbq.length) console.log(`   ⚠️  MISMATCH`);

  console.log('\n🍳 Breakfast Menu:');
  console.log(`   Obsidian: ${obsBr.length} items`);
  console.log(`   Firebase: ${fbBreakfast.length} items (${fbBreakfastSelected} selected)`);

  // Tasks
  const tasksMd = readMd('משימות.md');
  const obsTasks = tasksMd ? parseTasksMd(tasksMd) : [];
  const obsChecked = obsTasks.filter(t => t.done).length;
  const fbTasks = data?.tasks || {};
  const fbChecked = Object.values(fbTasks).filter(t => t.done).length;
  const fbAssigned = Object.values(fbTasks).filter(t => t.assignee).length;

  console.log('\n📋 Tasks:');
  console.log(`   Obsidian: ${obsTasks.length} tasks (${obsChecked} checked)`);
  console.log(`   Firebase: ${Object.keys(fbTasks).length} with state (${fbChecked} checked, ${fbAssigned} assigned)`);

  // Shopping
  const shopMd = readMd('רשימת_קניות_וציוד.md');
  const obsShopCount = shopMd ? (shopMd.match(/⬜/g) || []).length : 0;
  const fbShop = data?.shopping || {};
  const fbShopDone = Object.values(fbShop).filter(s => s.done).length;

  console.log('\n🛒 Shopping:');
  console.log(`   Obsidian: ${obsShopCount} unchecked items`);
  console.log(`   Firebase: ${Object.keys(fbShop).length} with state (${fbShopDone} bought)`);

  // Notes
  const fbNotes = data?.notes || {};
  console.log(`\n📝 Notes in Firebase: ${Object.keys(fbNotes).length}`);
  Object.entries(fbNotes).forEach(([id, n]) => {
    console.log(`   ${id}: "${n.text}" (${n.author})`);
  });

  console.log('\n---');
  console.log('Run "node sync.js pull" to update Obsidian from Firebase');
  console.log('Run "node sync.js push" to push Obsidian changes to Firebase');
  console.log('Run "node sync.js push --force" to overwrite Firebase menus with Obsidian');
}

// ============================================
// CLI
// ============================================

const command = process.argv[2] || 'status';
const force = process.argv.includes('--force');

switch (command) {
  case 'status':
    showStatus().catch(console.error);
    break;
  case 'pull':
    pullToObsidian().catch(console.error);
    break;
  case 'push':
    pushToFirebase(force).catch(console.error);
    break;
  default:
    console.log(`
📦 sync.js - Bidirectional sync: Obsidian ↔ Firebase ↔ App

Usage:
  node sync.js status          Show differences
  node sync.js pull            Firebase → Obsidian (update MD files)
  node sync.js push            Obsidian → Firebase (push changes)
  node sync.js push --force    Overwrite Firebase menus with Obsidian

Workflow:
  1. GF edits in app  → run "pull"  → Obsidian updates
  2. You edit in Obsidian → run "push" → app updates
`);
}
