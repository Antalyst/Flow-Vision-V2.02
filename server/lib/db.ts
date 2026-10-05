import { Sequelize } from 'sequelize'
import mysql2 from 'mysql2'
import { env } from './env.ts'

export const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'mysql',
  // Passed explicitly so the Nitro bundle doesn't depend on Sequelize's dynamic require('mysql2').
  dialectModule: mysql2,
  timezone: '+00:00',
  logging: env.db.logging ? console.log : false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  define: {
    underscored: true,
    freezeTableName: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  dialectOptions: {
    // Return DECIMAL columns as numbers rather than strings
    decimalNumbers: true,
  },
})
