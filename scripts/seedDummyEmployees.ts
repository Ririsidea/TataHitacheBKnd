// Seeds (or removes) 200 dummy employees for load/pagination testing.
//   npm run seed:dummy          - insert the 200 dummy employees (idempotent - safe to re-run)
//   npm run seed:dummy:remove   - delete ONLY the dummy employees this script created
//
// A dummy row is identified by BOTH: email ending in "@example.com" AND employeeId inside
// [DUMMY_EMPLOYEE_ID_START, DUMMY_EMPLOYEE_ID_END] - the same two-part check is used to seed
// (skip what already exists) and to remove (never touch a real employee or the admin, even if a
// real employee were ever given an @example.com email or a colliding id by hand).
import bcrypt from 'bcrypt';
import { Op } from 'sequelize';
import connectDB, { sequelize } from '../src/config/db';
import { User } from '../src/models';

const DUMMY_COUNT = 200;
const DUMMY_EMPLOYEE_ID_START = 20001;
const DUMMY_EMPLOYEE_ID_END = DUMMY_EMPLOYEE_ID_START + DUMMY_COUNT - 1; // 20200
const DUMMY_PASSWORD = 'Test@1234';
const SALT_ROUNDS = 12;
const BATCH_SIZE = 100;

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan',
  'Priya', 'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Kavya', 'Meera', 'Riya', 'Isha', 'Neha',
  'Rahul', 'Amit', 'Vikram', 'Suresh', 'Rajesh', 'Anil', 'Manoj', 'Deepak', 'Sanjay', 'Ajay',
  'Pooja', 'Sneha', 'Divya', 'Shreya', 'Nisha', 'Kritika', 'Swati', 'Ritu', 'Anjali', 'Preeti',
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Nair', 'Iyer', 'Reddy', 'Patel', 'Singh', 'Kumar', 'Rao',
  'Mehta', 'Joshi', 'Desai', 'Kapoor', 'Malhotra', 'Chopra', 'Bose', 'Mukherjee', 'Pillai', 'Menon',
  'Agarwal', 'Bansal', 'Chauhan', 'Dubey', 'Ghosh', 'Jain', 'Kaur', 'Nayak', 'Pandey', 'Saxena',
];

interface DummyRow {
  name: string;
  email: string;
  employeeId: string;
  phone: string;
}

// firstname.lastname.NNN@example.com - the NNN suffix alone already guarantees a unique email
// even where the name combination itself repeats (40 x 30 = 1200 combinations, only 200 needed).
function buildDummyRows(): DummyRow[] {
  const rows: DummyRow[] = [];
  for (let i = 0; i < DUMMY_COUNT; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length] as string;
    const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length] as string;
    const suffix = String(i + 1).padStart(3, '0');
    const email = `${first.toLowerCase()}.${last.toLowerCase()}.${suffix}@example.com`;
    const employeeId = String(DUMMY_EMPLOYEE_ID_START + i);
    const phonePrefix = ['9', '8', '7'][i % 3];
    const phoneRest = String(100000000 + ((i * 9973) % 900000000)).padStart(9, '0');
    const phone = `${phonePrefix}${phoneRest}`;
    rows.push({ name: `${first} ${last}`, email, employeeId, phone });
  }
  return rows;
}

async function seed(): Promise<void> {
  await connectDB();

  const before = await User.count();

  const rows = buildDummyRows();
  const emails = rows.map((r) => r.email);
  const employeeIds = rows.map((r) => r.employeeId);

  const existing = await User.findAll({
    attributes: ['email', 'employeeId'],
    where: { [Op.or]: [{ email: { [Op.in]: emails } }, { employeeId: { [Op.in]: employeeIds } }] },
  });
  const existingEmails = new Set(existing.map((u) => u.email));
  const existingEmployeeIds = new Set(existing.map((u) => u.employeeId));

  const toInsert = rows.filter((r) => !existingEmails.has(r.email) && !existingEmployeeIds.has(r.employeeId));
  const skipped = rows.length - toInsert.length;

  // Hashed once, reused for all 200 rows - this is dummy test data, not a real per-user secret.
  const passwordHash = await bcrypt.hash(DUMMY_PASSWORD, SALT_ROUNDS);

  await sequelize.transaction(async (transaction) => {
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE).map((r) => ({
        email: r.email,
        employeeId: r.employeeId,
        name: r.name,
        phone: r.phone,
        passwordHash,
        mustResetPassword: false,
      }));
      await User.bulkCreate(batch, { transaction });
    }
  });

  const after = await User.count();

  console.log(`Users before: ${before}`);
  console.log(`Users after: ${after}`);
  console.log(`Dummy employees created: ${toInsert.length}, skipped (already existed): ${skipped}`);

  const sample = await User.findAll({
    where: { employeeId: { [Op.between]: [String(DUMMY_EMPLOYEE_ID_START), String(DUMMY_EMPLOYEE_ID_END)] } },
    order: [['employeeId', 'ASC']],
    limit: 5,
    attributes: ['id', 'name', 'email', 'employeeId', 'phone', 'mustResetPassword'],
  });
  console.log('\nSample rows:');
  for (const u of sample) {
    console.log(`  id=${u.id} employeeId=${u.employeeId} name=${u.name} email=${u.email} phone=${u.phone} mustResetPassword=${u.mustResetPassword}`);
  }
}

async function remove(): Promise<void> {
  await connectDB();

  const before = await User.count();
  const deleted = await User.destroy({
    where: {
      email: { [Op.like]: '%@example.com' },
      employeeId: { [Op.between]: [String(DUMMY_EMPLOYEE_ID_START), String(DUMMY_EMPLOYEE_ID_END)] },
    },
  });
  const after = await User.count();

  console.log(`Users before: ${before}`);
  console.log(`Dummy employees removed: ${deleted}`);
  console.log(`Users after: ${after}`);
}

const isRemove = process.argv.includes('--remove');
(isRemove ? remove() : seed())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('seedDummyEmployees failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
