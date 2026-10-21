/*
 * One-time setup: creates every column from config/monday-columns.js on your
 * Monday board, with the exact column IDs the Netlify functions expect.
 *
 * Run (Node 18+):
 *   MONDAY_API_TOKEN=your_token MONDAY_BOARD_ID=1234567890 node scripts/setup-monday-board.js
 *
 * Columns that already exist (same ID) are skipped, so it is safe to run twice.
 */
const { columns } = require('../config/monday-columns.js');

const token = process.env.MONDAY_API_TOKEN;
const board = process.env.MONDAY_BOARD_ID;
if (!token || !board) {
  console.error('Set MONDAY_API_TOKEN and MONDAY_BOARD_ID first.');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors || json.error_message) throw new Error(JSON.stringify(json.errors || json.error_message));
  return json.data;
}

(async () => {
  const data = await gql('query ($b: [ID!]) { boards (ids: $b) { name columns { id title type } } }', { b: [board] });
  const b = data.boards[0];
  if (!b) throw new Error('Board not found: ' + board);
  const existing = new Set(b.columns.map((c) => c.id));
  console.log('Board:', b.name);

  for (const col of Object.values(columns)) {
    if (existing.has(col.id)) { console.log('  exists   ', col.id); continue; }
    await gql(
      'mutation ($b: ID!, $t: String!, $type: ColumnType!, $id: String) { create_column (board_id: $b, title: $t, column_type: $type, id: $id) { id } }',
      { b: board, t: col.title, type: col.type, id: col.id }
    );
    console.log('  created  ', col.id, '(' + col.type + ')');
  }
  console.log('Done.');
})().catch((e) => { console.error('Setup failed:', e.message); process.exit(1); });
