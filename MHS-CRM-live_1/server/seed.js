/* ============================================================
   MHS CRM — seed data: Admin + 1 Team Lead + 10 Sales + dummy leads
   Run:  npm run seed         (only seeds if DB is empty)
         node seed.js reset   (wipes leads/users and re-seeds)
   ============================================================ */
const { db, hashPin, uid } = require('./db');

const USERS = [
  { id: 'u_admin', name: 'Abhishek Vyas',    email: 'abhishek@myhaulstore.com',  role: 'admin', team: '-',   pin: '1111' },
  { id: 'u_lead',  name: 'Rahul Mehta',      email: 'rahul@myhaulstore.com',     role: 'lead',  team: 'TPA', pin: '2222' },
  { id: 's01', name: 'Abhishek Bhadoriya', email: 'abhishekb@myhaulstore.com', role: 'sales', team: 'TPA', pin: '0001' },
  { id: 's02', name: 'Aishwarya Deshmukh', email: 'aishwaryad@myhaulstore.com',role: 'sales', team: 'TPA', pin: '0002' },
  { id: 's03', name: 'Akshay Bhosale',     email: 'akshayb@myhaulstore.com',   role: 'sales', team: 'TPA', pin: '0003' },
  { id: 's04', name: 'Akshay Sangle',      email: 'akshays@myhaulstore.com',   role: 'sales', team: 'TPA', pin: '0004' },
  { id: 's05', name: 'Ankit Singh',        email: 'ankit@myhaulstore.com',     role: 'sales', team: 'TFD', pin: '0005' },
  { id: 's06', name: 'Anu Sharma',         email: 'anu@myhaulstore.com',       role: 'sales', team: 'TFD', pin: '0006' },
  { id: 's07', name: 'Anurag Das',         email: 'anurag@myhaulstore.com',    role: 'sales', team: 'TFD', pin: '0007' },
  { id: 's08', name: 'Arati Innani',       email: 'arti@myhaulstore.com',      role: 'sales', team: 'MHS', pin: '0008' },
  { id: 's09', name: 'Babitha Bhuwalia',   email: 'babitha@myhaulstore.com',   role: 'sales', team: 'MHS', pin: '0009' },
  { id: 's10', name: 'Prachi Nair',        email: 'prachi@myhaulstore.com',    role: 'sales', team: 'TPK', pin: '0010' },
];

const F = {
  first: ['Rohan','Priya','Amit','Sneha','Vikram','Anjali','Rahul','Pooja','Karan','Divya','Suresh','Meera',
    'Nikhil','Kavya','Arjun','Isha','Deepak','Ritu','Manish','Neha','Sanjay','Tanvi','Gaurav','Shweta',
    'Vivek','Aditi','Rajesh','Simran','Harsh','Payal','Aakash','Nidhi','Yash','Komal','Sameer','Bhavna'],
  last: ['Sharma','Verma','Patel','Gupta','Singh','Reddy','Nair','Iyer','Das','Mehta','Joshi','Kapoor',
    'Rao','Shah','Kulkarni','Bose','Chauhan','Malhotra','Pillai','Bhatt'],
  city: ['Mumbai','Delhi','Bengaluru','Pune','Hyderabad','Chennai','Ahmedabad','Kolkata','Jaipur','Surat',
    'Indore','Lucknow','Nagpur','Bhopal','Chandigarh'],
};
const SOURCES = ['Facebook','Google Ads','Website','Chatbot','WhatsApp','Calendly','LinkedIn','Bulk Upload','Manual','Others'];
const STATUS_POOL = ['Fresh','Fresh','Fresh','RNR','RNR','Follow Up','Follow Up','Follow Up','Follow Up',
  'Interested','Interested','Not Interested','Junk','Closed Won','Closed Won','Closed Lost'];

function pad(n, l) { n = String(n); while (n.length < l) n = '0' + n; return n; }
function dateFromNow(d) { const t = new Date(); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); }

function seed(reset) {
  if (reset) {
    db.exec('DELETE FROM activities; DELETE FROM leads; DELETE FROM users; DELETE FROM rr_state; DELETE FROM calls;');
    console.log('reset: cleared users/leads/activities/calls');
  }
  const existing = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (existing > 0 && !reset) { console.log('users already present (' + existing + ') — skip. Use `node seed.js reset` to force.'); return; }

  const insUser = db.prepare(`INSERT INTO users(id,name,email,role,team,department,pin_hash,pin_salt,active) VALUES(?,?,?,?,?,?,?,?,1)`);
  for (const u of USERS) {
    const { hash, salt } = hashPin(u.pin);
    const dept = u.role === 'admin' ? 'Admin' : u.role === 'lead' ? 'Sales Manager' : u.team + ' Sales';
    insUser.run(u.id, u.name, u.email, u.role, u.team, dept, hash, salt);
  }
  console.log('seeded ' + USERS.length + ' users');

  const sales = USERS.filter(u => u.role === 'sales');
  const insLead = db.prepare(`INSERT INTO leads(id,name,phone,email,city,product,source,status,owner_id,website,score,converted,next_followup,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insAct = db.prepare(`INSERT INTO activities(lead_id,title,sub,by_name,created_at) VALUES(?,?,?,?,?)`);
  const WON = new Set(['Closed Won']); const OPEN = new Set(['Fresh','RNR','Follow Up','Interested']);

  let n = 0;
  for (let i = 0; i < 64; i++) {
    const fn = F.first[i % F.first.length];
    const ln = F.last[(i * 3 + 7) % F.last.length];
    const owner = sales[i % sales.length];
    let status = STATUS_POOL[i % STATUS_POOL.length];
    if (owner.id === 's04' && i !== 3) status = 'Junk';           // demo: Junk over-user → admin alert
    const source = SOURCES[i % SOURCES.length];
    const product = owner.team;
    const city = F.city[(i * 5 + 2) % F.city.length];
    const id = 'L' + (1001 + i);
    const created = new Date(); created.setDate(created.getDate() - ((i % 20) + 1));
    const createdISO = created.toISOString();
    const follow = OPEN.has(status) ? dateFromNow([-2,-1,0,0,1,2,3][i % 7]) : null;
    const score = ((source==='Website'||source==='WhatsApp'||source==='Calendly') ? 70 : 45) + (WON.has(status)?25:0) + (status==='Interested'?15:0);
    insLead.run(id, fn+' '+ln, '+91 9'+pad((i*7654321)%900000000+100000000,9).slice(0,9),
      (fn+'.'+ln).toLowerCase()+'@gmail.com', city, product, source, status, owner.id,
      ['myhaulstore.com','tpads.in','foundersdream.co','-'][i%4], score, WON.has(status)?1:0, follow, createdISO);
    insAct.run(id, 'Lead created', 'Source: ' + source, 'System', createdISO);
    if (status !== 'Fresh') insAct.run(id, 'Called — ' + (status==='RNR'?'No response':'Spoke with customer'), '', owner.name, createdISO);
    if (WON.has(status)) insAct.run(id, 'Marked Closed Won', 'Pushed to Customer CRM', owner.name, createdISO);
    n++;
  }
  console.log('seeded ' + n + ' leads');

  // seed calls: realistic first-response (near lead creation) + today's activity
  const insCall = db.prepare(`INSERT INTO calls(lead_id,owner_id,connected,talktime,created_at) VALUES(?,?,?,?,?)`);
  const addMin = (iso, mins) => { const d = new Date(iso); d.setMinutes(d.getMinutes() + mins); return d.toISOString(); };
  const leadRows = db.prepare('SELECT id,owner_id,status,created_at FROM leads').all();
  let ci = 0;
  for (const l of leadRows) {
    if (l.status !== 'Fresh') insCall.run(l.id, l.owner_id, 1, 90 + (ci * 17) % 480, addMin(l.created_at, 2 + (ci % 18)));
    ci++;
  }
  const perAgentToday = [5, 0, 8, 3, 0, 6, 4, 2, 7, 1];
  db.prepare("SELECT id FROM users WHERE role='sales' ORDER BY id").all().forEach((u, i) => {
    const lrs = db.prepare("SELECT id FROM leads WHERE owner_id=? AND status!='Fresh' LIMIT ?").all(u.id, perAgentToday[i] || 0);
    lrs.forEach((lr, k) => insCall.run(lr.id, u.id, 1, 60 + (k * 40) % 500, new Date().toISOString()));
  });
  console.log('seeded call logs (response + talk-time)');

  console.log('\nLogin PINs →  Admin 1111 | Team Lead 2222 | Sales 0001…0010');
}

if (require.main === module) seed(process.argv.includes('reset'));
module.exports = seed;
