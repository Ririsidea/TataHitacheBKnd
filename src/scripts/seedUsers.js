const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const connectDB = require('../config/db');
const { User } = require('../models');
const { validatePassword } = require('../utils/passwordPolicy');

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

function capitalize(segment) {
  return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
}

function deriveNameAndPassword(email) {
  const localPart = email.split('@')[0];
  const segments = localPart.split('.').map(capitalize);
  const name = segments.join(' ');
  const password = `${segments[0]}@1234`;
  return { name, password };
}

async function seed() {
  await connectDB();
  // Creates the users table if it doesn't already exist, without touching other tables.
  await User.sync();

  const uniqueEmails = [...new Set(EMPLOYEE_EMAILS.map((e) => e.trim().toLowerCase()))];

  let created = 0;
  let skipped = 0;
  const passwordLines = [];

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

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await User.create({ email, name, passwordHash, mustResetPassword: true });
    passwordLines.push(`${email}\t${password}`);
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
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exit(1);
  });
