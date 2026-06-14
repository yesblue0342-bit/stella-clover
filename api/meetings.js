const { initDb, sql } = require('./_db');

module.exports = async function (req, res) {
  try {
    const pool = await initDb();
    if (req.method === 'GET') {
      const result = await pool.request().query('SELECT TOP 30 id, project_name, title, participants, created_at FROM cl_meetings ORDER BY id DESC');
      return res.status(200).json({ items: result.recordset });
    }
    return res.status(405).json({ message: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};
