import pg from 'pg';
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('error', (err) => {
    console.error('Error inactivo en el pool de PostrgreSQL:', err.message, err.stack);
});

async function query(sql, values = []) {
    const client = await pool.connect();
    try {
        const result = await client.query(sql, values);
        return result.rows;
    } finally {
        client.release();
    }
}

export { query };