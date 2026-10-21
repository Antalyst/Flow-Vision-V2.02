// Creates the ONE initial administrator of a new installation (there is no public sign-up).
// Runs once: afterwards it refuses, and that administrator creates every other account in the app.
// Refuses remote hosts unless --remote, like the other database scripts.
//
//   npm run admin:bootstrap                       interactive: asks for the details; the password is typed hidden
//   npm run admin:bootstrap -- --status           only reports whether the bootstrap already ran
//   npm run admin:bootstrap -- --remote           against a non-local database (e.g. the hosted one)
//
// Non-interactive (deployment, no terminal) — set these for this one command, then remove them:
//   FV_BOOTSTRAP_ADMIN_EMAIL, FV_BOOTSTRAP_ADMIN_FIRST_NAME, FV_BOOTSTRAP_ADMIN_LAST_NAME,
//   FV_BOOTSTRAP_ADMIN_PASSWORD, FV_BOOTSTRAP_ORG_NAME (empty installation) or FV_BOOTSTRAP_ORG_ID
//   (several organizations). A password given this way has passed through configuration, so the
//   account must choose its own at first sign-in.
// The password is never accepted as a command-line argument and never printed.
// Never calls process.exit(): it sets the exit code and ends normally (an early process.exit() can
// crash Node 23 on Windows in this script). Exit codes: 0 done, 1 error, 2 bad input, 3 already done.
import { assertSafeTarget } from './guard.ts'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env — rely on the environment */
}
const { env } = await import('../server/lib/env.ts')

const fail = (message: string, code = 1) => {
  console.error(`[bootstrap] ${message}`)
  process.exitCode = code
}

/** Ask on the terminal; `hidden` echoes nothing (passwords). */
async function ask(question: string, { hidden = false } = {}) {
  const [{ default: readline }, { Writable }] = await Promise.all([import('node:readline'), import('node:stream')])
  let muted = false
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding)
      done()
    },
  })
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(hidden ? answer : answer.trim())
    })
    muted = hidden
  })
}

async function main() {
  const { sequelize } = await import('../server/lib/models.ts')
  const { bootstrapAdmin, bootstrapStatus, BootstrapError, adminPasswordProblem } = await import('../server/lib/bootstrap.ts')
  try {
    await run()
  } catch (err) {
    if (err instanceof BootstrapError) fail(`${err.message} — nothing was changed.`, err.code === 'ALREADY_DONE' ? 3 : 2)
    else fail((err as Error).message)
  } finally {
    await sequelize.close()
  }

  async function run() {
    try {
      await sequelize.authenticate()
    } catch (err) {
      throw new Error(`cannot connect to ${env.db.host}:${env.db.port}/${env.db.name} — check DB_HOST, DB_PORT, DB_USER, DB_PASS and DB_NAME (${(err as { parent?: { code?: string } }).parent?.code ?? (err as Error).message})`)
    }

    const status = await bootstrapStatus()
    if (process.argv.includes('--status')) {
      if (!status.migrated) console.log('[bootstrap] not migrated: run npm run db:migrate (or database/migrations/2026-10-24-admin-bootstrap.sql) first')
      else if (status.done) console.log(`[bootstrap] done${status.marker ? ` (${status.marker.method === 'EXISTING' ? 'existing installation' : 'initial administrator created'} ${new Date(status.marker.completed_at).toISOString()})` : ''}; ${status.admins} administrator account(s)`)
      else console.log(`[bootstrap] not done yet; ${status.organizations} organization(s), no administrator`)
    } else if (!status.migrated) {
      fail('the system_bootstrap table is missing. Run the database migration first (npm run db:migrate, or database/migrations/2026-10-24-admin-bootstrap.sql).')
    } else if (status.done) {
      fail('this installation already has its initial administrator — nothing was changed. Sign in as an administrator and create further accounts on the Accounts page.', 3)
    } else {
      const fromEnv = Boolean(process.env.FV_BOOTSTRAP_ADMIN_PASSWORD)
      let input
      if (fromEnv) {
        input = {
          email: process.env.FV_BOOTSTRAP_ADMIN_EMAIL,
          firstName: process.env.FV_BOOTSTRAP_ADMIN_FIRST_NAME,
          lastName: process.env.FV_BOOTSTRAP_ADMIN_LAST_NAME,
          password: process.env.FV_BOOTSTRAP_ADMIN_PASSWORD,
          organizationName: process.env.FV_BOOTSTRAP_ORG_NAME,
          organizationId: process.env.FV_BOOTSTRAP_ORG_ID,
          mustChangePassword: true,
        }
      } else if (process.stdin.isTTY) {
        console.log('[bootstrap] creating the initial administrator. Nothing is saved until the end.')
        const organizationName = status.organizations === 0 ? await ask('Organization name: ') : undefined
        const organizationId = status.organizations > 1 ? await ask(`Organization id (this database has ${status.organizations}): `) : undefined
        const email = await ask('Administrator email: ')
        const firstName = await ask('First name: ')
        const lastName = await ask('Last name: ')
        let password = ''
        for (let tries = 0; tries < 3 && !password; tries++) {
          const first = await ask('Password (12+ characters, hidden): ', { hidden: true })
          const problem = adminPasswordProblem(first, { email: email.toLowerCase(), organizationName })
          if (problem) console.log(`[bootstrap] ${problem}.`)
          else if ((await ask('Repeat the password: ', { hidden: true })) !== first) console.log('[bootstrap] the passwords do not match.')
          else password = first
        }
        if (!password) throw new BootstrapError('INVALID_INPUT', 'no acceptable password was entered')
        input = { email, firstName, lastName, password, organizationName, organizationId, mustChangePassword: false }
      } else {
        throw new BootstrapError('INVALID_INPUT', 'no terminal to ask on: run it in an interactive terminal (on Git Bash: winpty npm.cmd run admin:bootstrap), or set the FV_BOOTSTRAP_* variables')
      }

      const result = await bootstrapAdmin(input)
      console.log(`[bootstrap] initial administrator created: ${result.email}`)
      console.log(`[bootstrap] organization: ${result.organizationName}${result.organizationCreated ? ' (created, with the default document types)' : ''}`)
      console.log('[bootstrap] next: sign in at /login with that email.' + (fromEnv ? ' You will be asked to choose a new password; then remove FV_BOOTSTRAP_ADMIN_PASSWORD from the environment.' : ''))
      console.log('[bootstrap] then, as the administrator: Organization Settings (profile, logo, working hours, document types), Offices, Routes, and Accounts')
      console.log('[bootstrap] (Department Heads, Staff, Messengers); each office\'s Department Head sets up its umbrella offices. This command will refuse to run again.')
    }
  }
}

const safe = assertSafeTarget('bootstrap', { host: env.db.host, port: env.db.port, name: env.db.name }, { exit: false })
if (safe && process.argv.some((a) => /^--password(=|$)/.test(a))) {
  fail('the password is never taken from the command line (shell history, process list). Type it when asked, or use FV_BOOTSTRAP_ADMIN_PASSWORD.', 2)
} else if (safe) {
  await main()
}
