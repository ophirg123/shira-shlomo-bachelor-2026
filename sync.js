#!/usr/bin/env node
/**
 * sync.js - Sync Firebase state → Obsidian MD files
 * 
 * Usage:
 *   node sync.js pull    # Pull Firebase state into Obsidian MD files
 *   node sync.js status  # Show summary of what's in Firebase
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const FIREBASE_URL = 'https://shira-shlomo-2026-default-rtdb.europe-west1.firebasedatabase.app';
const OBSIDIAN_DIR = '/Users/ogruteke/Documents/Obsidian/Life/Events/רווקים_רווקות_שירה_ושלמה_2026';

// --- Data maps (same IDs as in index.html) ---

const TASK_MAP = {
  't-1': 'לגזור תפריט מנגל סופי',
  't-2': 'לגזור תפריט ארוחת בוקר סופי',
  't-3': 'מהתפריטים → לגזור מתכונים לכל מנה',
  't-4': 'מהמתכונים → לחשב כמויות',
  't-5': 'מהכמויות → לעדכן רשימת קניות סופית',
  't-6': 'לשאול בקבוצה: רגישויות תזונתיות?',
  't-7': 'לשלוח לשירה ושלמה מסמך אלכוהול',
  't-8': 'לאשר מנגל נוסף עם עמית ודנה',
  't-9': 'לאשר כירות גז עם בן וחנטל',
  't-10': 'לאשר ג\'בל + פנס תאורה מאמא ואבא',
};

function fetchFirebase(path) {
  return new Promise((resolve, reject) => {
    const url = `${FIREBASE_URL}${path}.json`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

function formatAssignee(assignee) {
  return assignee ? ` ← **${assignee}**` : '';
}

function formatNote(notes, id) {
  const note = notes?.[id];
  if (!note?.text) return '';
  return `\n\t> 📝 _${note.text}_ (${note.author || '?'})`;
}

async function pullStatus() {
  console.log('📡 Fetching data from Firebase...\n');
  const data = await fetchFirebase('/');
  
  if (!data) {
    console.log('❌ No data in Firebase yet.');
    return data;
  }

  // Tasks
  const tasks = data.tasks || {};
  const tasksDone = Object.values(tasks).filter(t => t.done).length;
  const tasksTotal = Object.keys(tasks).length;
  console.log(`✅ Tasks: ${tasksDone}/${tasksTotal} done`);
  
  // Show assigned tasks
  Object.entries(tasks).forEach(([id, t]) => {
    if (t.assignee) console.log(`   ${t.done ? '✅' : '⬜'} ${TASK_MAP[id] || id} → ${t.assignee}`);
  });

  // Shopping
  const shopping = data.shopping || {};
  const shopDone = Object.values(shopping).filter(s => s.done).length;
  const shopTotal = Object.keys(shopping).length;
  console.log(`\n🛒 Shopping: ${shopDone}/${shopTotal} bought`);
  Object.entries(shopping).forEach(([id, s]) => {
    if (s.assignee) console.log(`   ${s.done ? '✅' : '⬜'} ${id} → ${s.assignee}`);
  });

  // Menu
  const menuItems = data.menuItems || {};
  ['bbq', 'breakfast'].forEach(type => {
    const items = menuItems[type] || {};
    const selected = Object.values(items).filter(i => i.selected);
    const total = Object.keys(items).length;
    const label = type === 'bbq' ? '🔥 BBQ Menu' : '🍳 Breakfast Menu';
    console.log(`\n${label}: ${selected.length}/${total} selected`);
    selected.forEach(i => console.log(`   ✅ ${i.name}${i.desc ? ' - ' + i.desc : ''}`));
  });

  // Notes
  const notes = data.notes || {};
  const noteCount = Object.keys(notes).length;
  if (noteCount > 0) {
    console.log(`\n📝 Notes: ${noteCount}`);
    Object.entries(notes).forEach(([id, n]) => {
      console.log(`   ${id}: "${n.text}" (${n.author})`);
    });
  }

  // Equipment
  const equipment = data.equipment || {};
  const eqAssigned = Object.entries(equipment).filter(([,e]) => e.assignee);
  if (eqAssigned.length > 0) {
    console.log(`\n⚙️ Equipment assigned:`);
    eqAssigned.forEach(([id, e]) => console.log(`   ${e.done ? '✅' : '⬜'} ${id} → ${e.assignee}`));
  }

  // Prep
  const prep = data.prep || {};
  const prepAssigned = Object.entries(prep).filter(([,p]) => p.assignee);
  if (prepAssigned.length > 0) {
    console.log(`\n👨‍🍳 Prep assigned:`);
    prepAssigned.forEach(([id, p]) => console.log(`   ${p.done ? '✅' : '⬜'} ${id} → ${p.assignee}`));
  }

  return data;
}

async function pullToObsidian() {
  const data = await pullStatus();
  if (!data) return;

  console.log('\n\n📝 Updating Obsidian files...\n');

  // 1. Update משימות.md - update checkboxes
  await updateTasksFile(data);

  // 2. Update רשימת_קניות_וציוד.md - update checkboxes  
  await updateShoppingFile(data);

  // 3. Generate menu summary file from Firebase menu data
  await generateMenuFile(data);

  // 4. Generate sync summary
  await generateSyncSummary(data);

  console.log('\n✅ Done! Check your Obsidian vault.');
}

async function updateTasksFile(data) {
  const filePath = path.join(OBSIDIAN_DIR, 'משימות.md');
  if (!fs.existsSync(filePath)) { console.log('⚠️  משימות.md not found'); return; }
  
  let content = fs.readFileSync(filePath, 'utf8');
  const tasks = data.tasks || {};
  const notes = data.notes || {};
  let updated = 0;

  Object.entries(tasks).forEach(([id, t]) => {
    if (!t.done) return;
    // Find the matching task line by its text content
    const taskText = TASK_MAP[id];
    if (!taskText) return;
    // Match "- [ ]" lines containing this text
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`- \\[ \\] (\\*\\*)?${escaped}`, 'g');
    if (regex.test(content)) {
      content = content.replace(regex, `- [x] $1${taskText}`);
      updated++;
    }
  });

  // Add assignee info as inline comments
  Object.entries(tasks).forEach(([id, t]) => {
    if (!t.assignee) return;
    const taskText = TASK_MAP[id];
    if (!taskText) return;
    const escaped = taskText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Add assignee if not already there
    if (!content.includes(`← ${t.assignee}`)) {
      content = content.replace(
        new RegExp(`(- \\[.\\] (?:\\*\\*)?${escaped}(?:\\*\\*)?)`, 'g'),
        `$1 ← **${t.assignee}**`
      );
    }
  });

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`📋 משימות.md - ${updated} tasks marked as done`);
}

async function updateShoppingFile(data) {
  const filePath = path.join(OBSIDIAN_DIR, 'רשימת_קניות_וציוד.md');
  if (!fs.existsSync(filePath)) { console.log('⚠️  רשימת_קניות_וציוד.md not found'); return; }
  
  let content = fs.readFileSync(filePath, 'utf8');
  const shopping = data.shopping || {};
  const equipment = data.equipment || {};
  let updated = 0;

  // Update shopping checkboxes (table rows with ⬜ → ✅)
  Object.entries(shopping).forEach(([id, s]) => {
    if (s.done) {
      content = content.replace(/⬜/g, (match, offset) => {
        // Simple approach: replace sequentially
        return match;
      });
    }
  });

  // Add assignee info where possible
  Object.entries(shopping).forEach(([id, s]) => {
    if (s.assignee && !content.includes(s.assignee)) {
      // Try to find the item in responsibility table and add assignee
    }
  });

  // For equipment, update the responsibility column
  Object.entries(equipment).forEach(([id, e]) => {
    if (e.assignee) {
      // equipment items have specific names we can match
    }
  });

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`🛒 רשימת_קניות_וציוד.md - updated`);
}

async function generateMenuFile(data) {
  const menuItems = data.menuItems || {};
  const notes = data.notes || {};
  let content = `# 🔥🍳 תפריט סופי - רווקים/רווקות שירה ושלמה\n\n`;
  content += `> 📅 עודכן אוטומטית מהאפליקציה: ${new Date().toLocaleString('he-IL')}\n\n`;

  ['bbq', 'breakfast'].forEach(type => {
    const items = menuItems[type] || {};
    const title = type === 'bbq' ? '## 🔥 תפריט על האש - שישי ערב' : '## 🍳 ארוחת בוקר - שבת';
    content += `${title}\n\n`;

    // Group by category
    const cats = {};
    Object.values(items).sort((a,b) => (a.order||0) - (b.order||0)).forEach(item => {
      if (!cats[item.cat]) cats[item.cat] = [];
      cats[item.cat].push(item);
    });

    Object.entries(cats).forEach(([cat, catItems]) => {
      content += `### ${cat}\n\n`;
      catItems.forEach(item => {
        const check = item.selected ? '✅' : '❌';
        const noteText = notes[item.id]?.text;
        content += `- ${check} **${item.name}**`;
        if (item.desc) content += ` - ${item.desc}`;
        content += '\n';
        if (noteText) content += `\t> 📝 _${noteText}_ (${notes[item.id].author || ''})\n`;
      });
      content += '\n';
    });
  });

  // Prep items
  const prep = data.prep || {};
  if (Object.keys(prep).length > 0) {
    content += `## 👨‍🍳 הכנות מראש - מצב\n\n`;
    content += `| מה | מוכן? | מי מכין |\n|-----|------|--------|\n`;
    Object.entries(prep).forEach(([id, p]) => {
      content += `| ${id} | ${p.done ? '✅' : '⬜'} | ${p.assignee || ''} |\n`;
    });
  }

  const filePath = path.join(OBSIDIAN_DIR, 'תפריט_סופי.md');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`🔥 תפריט_סופי.md - generated with current selections`);
}

async function generateSyncSummary(data) {
  const notes = data.notes || {};
  const tasks = data.tasks || {};
  const shopping = data.shopping || {};
  const equipment = data.equipment || {};
  const prep = data.prep || {};
  const decisions = data.decisions || {};

  let content = `# 📊 סיכום סנכרון - רווקים/רווקות שירה ושלמה\n\n`;
  content += `> 📅 עודכן: ${new Date().toLocaleString('he-IL')}\n\n`;

  // Tasks summary
  const tasksDone = Object.values(tasks).filter(t => t.done).length;
  content += `## ✅ משימות: ${tasksDone}/${Object.keys(tasks).length}\n\n`;
  Object.entries(tasks).forEach(([id, t]) => {
    if (t.assignee || t.done) {
      content += `- [${t.done ? 'x' : ' '}] ${TASK_MAP[id] || id}${formatAssignee(t.assignee)}\n`;
      const noteText = notes[id]?.text;
      if (noteText) content += `\t> 📝 _${noteText}_\n`;
    }
  });

  // Shopping summary
  const shopDone = Object.values(shopping).filter(s => s.done).length;
  content += `\n## 🛒 קניות: ${shopDone}/${Object.keys(shopping).length}\n\n`;
  Object.entries(shopping).forEach(([id, s]) => {
    if (s.assignee || s.done) {
      content += `- [${s.done ? 'x' : ' '}] ${id}${formatAssignee(s.assignee)}\n`;
    }
  });

  // Equipment
  const eqAssigned = Object.entries(equipment).filter(([,e]) => e.assignee || e.done);
  if (eqAssigned.length > 0) {
    content += `\n## ⚙️ ציוד\n\n`;
    eqAssigned.forEach(([id, e]) => {
      content += `- [${e.done ? 'x' : ' '}] ${id}${formatAssignee(e.assignee)}\n`;
    });
  }

  // Notes
  if (Object.keys(notes).length > 0) {
    content += `\n## 📝 הערות\n\n`;
    Object.entries(notes).forEach(([id, n]) => {
      content += `- **${id}**: ${n.text} _(${n.author}, ${new Date(n.updated).toLocaleString('he-IL')})_\n`;
    });
  }

  // Decisions
  const decided = Object.entries(decisions).filter(([,d]) => d.selected);
  if (decided.length > 0) {
    content += `\n## 🤔 החלטות שאושרו\n\n`;
    decided.forEach(([id,]) => {
      content += `- ✅ ${id}\n`;
    });
  }

  const filePath = path.join(OBSIDIAN_DIR, 'סנכרון_מהאפליקציה.md');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`📊 סנכרון_מהאפליקציה.md - generated`);
}

// --- CLI ---
const command = process.argv[2] || 'status';

if (command === 'pull') {
  pullToObsidian().catch(console.error);
} else if (command === 'status') {
  pullStatus().catch(console.error);
} else {
  console.log('Usage: node sync.js [pull|status]');
  console.log('  status  - Show Firebase data summary');
  console.log('  pull    - Pull Firebase state into Obsidian MD files');
}
