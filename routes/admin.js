const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Admin Signup
router.post('/admin/signup', async (req, res) => {
  const { fullname, adminId, password } = req.body;
  try {
    const connection = await pool.getConnection();
    
    // Check if adminId already exists
    const [existingUser] = await connection.query('SELECT * FROM users WHERE email = ?', [adminId]);
    if (existingUser.length > 0) {
      connection.release();
      return res.json({ success: false, message: 'Admin ID already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert new admin user with role 'admin'
    await connection.query(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [fullname, adminId, hashedPassword, 'admin']
    );
    
    connection.release();
    res.json({ success: true, message: 'Admin signup successful! Please login.' });
  } catch (error) {
    console.error('Admin signup error:', error.message);
    res.json({ success: false, message: 'Server error during admin signup' });
  }
});

// Admin Login
router.post('/admin/login', async (req, res) => {
  const { adminId, password } = req.body;
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT * FROM users WHERE email = ? AND role = ?', [adminId, 'admin']);
    
    if (users.length === 0) {
      connection.release();
      return res.json({ success: false, message: 'Invalid Admin ID or password' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    
    if (!isMatch) {
      connection.release();
      return res.json({ success: false, message: 'Invalid Admin ID or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    
    connection.release();
    res.json({ success: true, message: 'Admin login successful', data: { token, redirect: '/admindashboard.html' } });
  } catch (error) {
    console.error('Admin login error:', error.message);
    res.json({ success: false, message: 'Server error during admin login' });
  }
});

module.exports = router;