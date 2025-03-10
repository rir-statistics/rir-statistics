import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import child_process from 'node:child_process'
import { parseISO, formatISO, startOfTomorrow, startOfToday, startOfYesterday } from 'date-fns'
import exponentialBackOff from 'exponential-backoff'
import sqlite3 from 'sqlite3'
import config from './config.js'

net.setDefaultAutoSelectFamilyAttemptTimeout(1000)

const { backOff } = exponentialBackOff

const formatBasicDate = (date) =>
  formatISO(date, { format: 'basic', representation: 'date' })

const formatExtendedDateString = (date) => date === null || date === '00000000'
  ? '1970-01-01'
  : formatISO(parseISO(date), { format: 'extended', representation: 'date' })

const fetchURL = async (url) => {
  console.log('==> Fetching', url)
  const response = await fetch(url)
  if (!response.ok) {
    throw response
  }
  return response
}

const fetchStats = async (url) => {
  try {
    return await backOff(() => fetchURL(url), { numOfAttempts: 3 })
  } catch (error) {
    const urls = [
      url.replace('latest', formatBasicDate(startOfTomorrow())),
      url.replace('latest', formatBasicDate(startOfToday())),
      url.replace('latest', formatBasicDate(startOfYesterday()))
    ]

    for (const url of urls) {
      try {
        return await backOff(() => fetchURL(url), { numOfAttempts: 3 })
      } catch (ignored) {}
    }

    throw error
  }
}

const fetchAllStats = async (urls, db) => {
  const stats = (await Promise.all((await Promise.all(urls.map(fetchStats)))
    .sort((a, b) => new Date(a.headers.get('Last-Modified')) - new Date(b.headers.get('Last-Modified')))
    .map(async response => {
      const [version, ...content] = (await response.text())
        .split('\n')
        .filter(line => !line.startsWith('#') && line !== '')
        .map(line => line.split('|').map(field => field === '' ? null : field))
      const index = content.findIndex(fields => fields[fields.length - 1] !== 'summary')
      const summary = content.slice(0, index)
      const records = content.slice(index)

      version[4] = formatExtendedDateString(version[4])
      version[5] = formatExtendedDateString(version[5])

      records.forEach(record => {
        while (record.length < 8) {
          record.push(null)
        }
        if (record[5] !== null) {
          record[5] = formatExtendedDateString(record[5])
        }
      })

      return [[version], summary, records]
    })))
    .reduce((accu, stats) => accu.map((value, index) => value.concat(stats[index])), [[], [], []])

  stats[2].sort((a, b) => {
    if (a[2] < b[2]) {
      return -1
    }
    if (a[2] > b[2]) {
      return 1
    }
    const _a = a[3].split(/\W+/)
    const _b = b[3].split(/\W+/)
    for (let i = 0, len = Math.max(_a.length, _b.length); i < len; ++i) {
      const result = parseInt(_a[i], 36) - parseInt(_b[i], 36)
      if (result !== 0) {
        return result
      }
    }
    return 0
  })

  return new Promise(resolve => {
    db.serialize(function () {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('BEGIN TRANSACTION')

      const tables = [
        {
          schema: `CREATE TABLE version (
  version     character varying (${stats[0].reduce((accu, value) => Math.max(accu, value[0].length), 0)}),
  registry    character varying (${stats[0].reduce((accu, value) => Math.max(accu, value[1].length), 0)}),
  serial      bigint,
  records     bigint,
  startdate   date,
  enddate     date,
  UTCoffset   character (5),
  PRIMARY KEY (registry)
)`,
          insert: 'INSERT INTO version VALUES(?, ?, ?, ?, ?, ?, ?)'
        },
        undefined,
        {
          schema: `CREATE TABLE record (
  registry    character varying (${stats[0].reduce((accu, value) => Math.max(accu, value[1].length), 0)}),
  cc          character (2),
  type        character varying (4),
  start       character varying (39),
  value       integer,
  date        date,
  status      character varying (9),
  "opaque-id" character varying (36),
  PRIMARY KEY (type, start),
  FOREIGN KEY (registry) REFERENCES version(registry)
)`,
          insert: 'INSERT OR REPLACE INTO record VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
        }
      ]

      tables.forEach((table, index) => {
        if (table === undefined) {
          return
        }
        db.exec(table.schema)
        const statement = db.prepare(table.insert)
        stats[index].forEach(params => statement.run(params))
        statement.finalize()
      })

      db.run('COMMIT', resolve)
    })
  })
}

const main = async () => {
  const dest = config.dest + '.sql'

  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const filename = config.dest + '.db'
  fs.existsSync(filename) && fs.unlinkSync(filename)
  const db = new sqlite3.Database(filename)
  await fetchAllStats(config.source, db)
  db.close()

  await new Promise(async (resolve, reject) => {
    child_process.spawn('sqlite3', [filename, '.dump'], {
      stdio: [
        'ignore',
        await new Promise(resolve => {
          const stream = fs.createWriteStream(dest)
            .on('open', () => resolve(stream))
        }),
        'inherit'
      ]
    })
      .on('close', resolve)
      .on('error', reject)
  })

  fs.writeFileSync(dest, fs.readFileSync(dest, 'utf8').split('\n').map(line => line.replace(/^(?=PRAGMA )/, '-- ')).join('\n'))
}

;(async () => {
  try {
    await main()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})()
