import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import connectDB from '../config/db';
import { User } from '../models';
import { validatePassword } from '../utils/passwordPolicy';
import { errorMessage } from '../utils/errors';

const SALT_ROUNDS = 12;
const PASSWORDS_FILE = path.join(__dirname, 'seeded-passwords.local.txt');

// Emails appear as given; duplicates (kislay@irisidea.com, sruthi.e@irisidea.com) are
// deduped below so each employee is only inserted once.
const EMPLOYEE_EMAILS = [
  'rakesh.bannagare@irisidea.com',
  'sulaxmi@irisidea.com',
  'hemang.prashar@irisidea.com',
  'arun.raj@irisidea.com',
  'sruthi.e@irisidea.com',
  'kislay@irisidea.com',
  'krishna.veni@irisidea.com',
  'naveed.shaik@irisidea.com',
  'nabendu.kumar@irisidea.com',
  'aditya.bhat@irisidea.com',
  'bhaskar.sundaram@irisidea.com',
  'shashank.k@irisidea.com',
  'irisideatechnologies@gmail.com',
  'jagan@irisidea.com',
  'rehman.arjunagi@irisidea.com',
  'mailsecurity@tatahitachi.co.in',
  'vijay.parmar@tatahitachi.co.in',
];

function capitalize(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
}

function deriveNameAndPassword(email: string): { name: string; password: string } {
  const localPart = email.split('@')[0] as string;
  const segments = localPart.split('.').map(capitalize);
  const name = segments.join(' ');
  const password = `${segments[0]}@1234`;
  return { name, password };
}

const FIRST_EMPLOYEE_ID = 12345;

async function nextFreeEmployeeId(used: Set<string>): Promise<string> {
  let candidate = FIRST_EMPLOYEE_ID;
  while (used.has(String(candidate))) candidate += 1;
  const id = String(candidate);
  used.add(id);
  return id;
}

async function seed(): Promise<void> {
  await connectDB();
  // Creates the users table if it doesn't already exist, without touching other tables.
  await User.sync();

  const uniqueEmails = [...new Set(EMPLOYEE_EMAILS.map((e) => e.trim().toLowerCase()))];

  const existingIds = await User.findAll({ attributes: ['employeeId'] });
  const usedEmployeeIds = new Set(existingIds.map((u) => u.employeeId).filter(Boolean));

  let created = 0;
  let skipped = 0;
  const passwordLines: string[] = [];

  for (const email of uniqueEmails) {
    const existing = await User.findOne({ where: { email } });
    if (existing) {
      skipped += 1;
      continue;
    }

    const { name, password } = deriveNameAndPassword(email);
    const policyCheck = validatePassword(password);
    if (!policyCheck.valid) {
      throw new Error(`Generated password for ${email} fails policy: ${policyCheck.message}`);
    }

    const employeeId = await nextFreeEmployeeId(usedEmployeeIds);
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await User.create({ email, employeeId, name, passwordHash, mustResetPassword: true });
    passwordLines.push(`${email}\t${employeeId}\t${password}`);
    created += 1;
  }

  if (passwordLines.length) {
    fs.writeFileSync(
      PASSWORDS_FILE,
      `# Local reference only - gitignored, never commit.\n${passwordLines.join('\n')}\n`,
      'utf8'
    );
    console.log(`Seeded default passwords written to ${PASSWORDS_FILE} (local, gitignored).`);
  }

  console.log(`Seed complete: ${created} user(s) created, ${skipped} already existed.`);
}

seed()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('Seeding failed:', errorMessage(err));
    process.exit(1);
  });
