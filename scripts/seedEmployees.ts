// Seeds (or removes) dummy employees for load and pagination testing.
//   npm run seed:employees                  - top up to 10,000 @thcm-test.local employees (idempotent)
//   npm run seed:employees -- --count=500   - a different target (or SEED_COUNT env)
//   npm run seed:employees -- --reset       - delete the @thcm-test.local employees, then seed fresh
//   npm run seed:employees:clean            - delete ONLY the @thcm-test.local employees
//
// Every seeded row has an email ending in @thcm-test.local - a fake domain, so no mail can reach a
// real inbox, and the same check identifies the rows to clean up. Cleanup never touches the admin
// (ADMIN_EMAIL, or any role 'admin' row) or any employee whose email is not on that domain.
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { Op, type WhereOptions } from 'sequelize';
import { admin } from '../src/config/env';
import connectDB, { sequelize } from '../src/config/db';
import { User } from '../src/models';
import type { UserAttributes, UserCreationAttributes } from '../src/models/User';

const SEED_DOMAIN = 'thcm-test.local';
const DEFAULT_COUNT = 10000;
// employeeId and ticketId must both be unique across ~2N values drawn from the 90,000 five-digit
// numbers (10000-99999), so N is capped well below that.
const MAX_COUNT = 40000;
const BATCH_SIZE = 1000;
const SEED_PASSWORD = 'Test@1234';
const SALT_ROUNDS = 12;
const ID_MIN = 10000;
const ID_MAX = 99999;

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan',
  'Kabir', 'Atharv', 'Advait', 'Dhruv', 'Shaurya', 'Ayaan', 'Kunal', 'Nikhil', 'Siddharth', 'Tanmay',
  'Harsh', 'Yash', 'Om', 'Pranav', 'Varun', 'Karan', 'Akash', 'Abhishek', 'Gaurav', 'Mayank',
  'Tushar', 'Sumit', 'Rakesh', 'Amit', 'Vikram', 'Suresh', 'Rajesh', 'Anil', 'Manoj', 'Deepak',
  'Sanjay', 'Ajay', 'Mohit', 'Ravi', 'Pankaj', 'Vishal', 'Naveen', 'Prashant', 'Hemant', 'Girish',
  'Ashwin', 'Rahul', 'Sachin', 'Vijay', 'Ankit', 'Saurabh', 'Lokesh', 'Mahesh', 'Ganesh', 'Prakash',
  'Dinesh', 'Priya', 'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Kavya', 'Meera', 'Riya', 'Isha',
  'Neha', 'Pooja', 'Sneha', 'Divya', 'Shreya', 'Nisha', 'Kritika', 'Swati', 'Ritu', 'Anjali',
  'Preeti', 'Lakshmi', 'Revathi', 'Keerthi', 'Sindhu', 'Bhavana', 'Madhuri', 'Sunita', 'Geeta', 'Shalini',
  'Tanvi', 'Aishwarya', 'Harini', 'Gayathri', 'Jyoti', 'Simran', 'Monika', 'Nandini',
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Nair', 'Iyer', 'Reddy', 'Patel', 'Singh', 'Kumar', 'Rao',
  'Mehta', 'Joshi', 'Desai', 'Kapoor', 'Malhotra', 'Chopra', 'Bose', 'Mukherjee', 'Pillai', 'Menon',
  'Agarwal', 'Bansal', 'Chauhan', 'Dubey', 'Ghosh', 'Jain', 'Kaur', 'Nayak', 'Pandey', 'Saxena',
  'Shah', 'Trivedi', 'Thakur', 'Yadav', 'Mishra', 'Tiwari', 'Srinivasan', 'Krishnan', 'Subramanian', 'Raghavan',
  'Venkatesh', 'Naidu', 'Hegde', 'Shetty', 'Kulkarni', 'Deshpande', 'Patil', 'Gaikwad', 'Pawar', 'Jadhav',
  'Bhatt', 'Dixit', 'Rathore', 'Sengupta', 'Banerjee', 'Chatterjee', 'Das', 'Roy', 'Sinha', 'Prasad',
  'Bhat', 'Shenoy', 'Gowda', 'Chowdhury', 'Khanna', 'Arora', 'Sethi', 'Bhargava', 'Kashyap',
];

const pick = (list: string[]): string => list[crypto.randomInt(list.length)] as string;

// A 10-digit Indian mobile number: starts with 6, 7, 8 or 9.
function randomMobile(): string {
  let digits = String(crypto.randomInt(6, 10));
  for (let i = 0; i < 9; i++) digits += String(crypto.randomInt(10));
  return digits;
}

// One 5-digit value not already in `used`; it is added to the set so it is never handed out twice.
function takeUniqueDigits(used: Set<string>): string {
  for (;;) {
    const value = String(crypto.randomInt(ID_MIN, ID_MAX + 1));
    if (!used.has(value)) {
      used.add(value);
      return value;
    }
  }
}

// The only rows this script may touch: seed-domain emails, never the admin account.
function seedOnlyWhere(): WhereOptions<UserAttributes> {
  return {
    [Op.and]: [
      { email: { [Op.like]: `%@${SEED_DOMAIN}` } },
      { email: { [Op.ne]: admin.email } },
      { role: { [Op.ne]: 'admin' } },
    ],
  };
}

function parseCount(argv: string[], env: NodeJS.ProcessEnv): number {
  const arg = argv.find((a) => a.startsWith('--count='));
  const raw = arg ? arg.slice('--count='.length) : env.SEED_COUNT;
  if (raw === undefined || raw === '') return DEFAULT_COUNT;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`count must be a whole number from 1 to ${MAX_COUNT}`);
  }
  return count;
}

async function seed(count: number, reset: boolean): Promise<void> {
  const started = Date.now();
  await connectDB();

  if (reset) {
    const removed = await User.destroy({ where: seedOnlyWhere() });
    console.log(`--reset: removed ${removed} @${SEED_DOMAIN} employees`);
  }

  const alreadySeeded = await User.count({ where: seedOnlyWhere() });
  const toCreate = count - alreadySeeded;
  console.log(`Target ${count}; already seeded ${alreadySeeded}; to create ${Math.max(toCreate, 0)}`);
  if (toCreate <= 0) {
    console.log('Nothing to do.');
    return;
  }

  // Every employeeId and ticketId in use, across all users: a new value must not match any of them.
  const existing = await User.findAll({ attributes: ['employeeId', 'ticketId'] });
  const usedIds = new Set<string>();
  for (const user of existing) {
    usedIds.add(user.employeeId);
    if (user.ticketId) usedIds.add(user.ticketId);
  }

  // Hashed once and shared by every seeded row - 10,000 separate bcrypt hashes would be far too slow.
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);

  const rows: UserCreationAttributes[] = [];
  for (let i = 0; i < toCreate; i++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const employeeId = takeUniqueDigits(usedIds);
    rows.push({
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${employeeId}@${SEED_DOMAIN}`,
      name: `${first} ${last}`,
      employeeId,
      ticketId: takeUniqueDigits(usedIds),
      phone: randomMobile(),
      passwordHash,
      role: 'employee',
      mustResetPassword: false,
    });
  }

  let inserted = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const batchStarted = Date.now();
    await sequelize.transaction((transaction) => User.bulkCreate(batch, { transaction, validate: true }));
    inserted += batch.length;
    console.log(`  batch ${Math.floor(start / BATCH_SIZE) + 1}: +${batch.length} (${inserted}/${rows.length}) in ${Date.now() - batchStarted} ms`);
  }

  const sample = rows[0] as UserCreationAttributes;
  console.log(`Inserted ${inserted} employees in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`Sample login: identifier=${sample.employeeId} password=${SEED_PASSWORD} (${sample.email})`);
}

async function clean(): Promise<void> {
  await connectDB();
  const before = await User.count();
  const removed = await User.destroy({ where: seedOnlyWhere() });
  console.log(`Users before: ${before}`);
  console.log(`@${SEED_DOMAIN} employees removed: ${removed}`);
  console.log(`Users after: ${await User.count()}`);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed or clean test employees when NODE_ENV=production');
  }
  const argv = process.argv.slice(2);
  if (argv.includes('--clean')) return clean();
  return seed(parseCount(argv, process.env), argv.includes('--reset'));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('seedEmployees failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
