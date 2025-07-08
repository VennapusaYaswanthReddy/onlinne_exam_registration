const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
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

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Middleware to verify JWT and admin role
const authenticateAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied: Admin only' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Fetch Users
router.get('/admin/users', authenticateAdmin, async (req, res) => {
  const { role, paid, examId } = req.query;
  try {
    const connection = await pool.getConnection();
    let query = 'SELECT id, name, email, student_id AS studentId, role FROM users';
    const params = [];
    const conditions = [];

    if (role) {
      conditions.push('role = ?');
      params.push(role);
    }
    if (paid && examId) {
      conditions.push('id IN (SELECT user_id FROM payments WHERE exam_id = ? AND status = "paid")');
      params.push(examId);
    }
    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const [users] = await connection.query(query, params);
    connection.release();
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('Fetch users error:', error.message);
    res.json({ success: false, message: 'Server error fetching users' });
  }
});

// Add User
router.post('/admin/users', authenticateAdmin, async (req, res) => {
  const { name, email, studentId, role } = req.body;
  try {
    const connection = await pool.getConnection();
    const [existingUser] = await connection.query('SELECT * FROM users WHERE email = ? OR student_id = ?', [email, studentId]);
    if (existingUser.length > 0) {
      connection.release();
      return res.json({ success: false, message: 'Email or Student ID already exists' });
    }

    // Generate a default password (e.g., studentId123)
    const defaultPassword = `${studentId}123`;
    const hashedPassword = await require('bcrypt').hash(defaultPassword, 10);

    await connection.query(
      'INSERT INTO users (name, email, student_id, password, role) VALUES (?, ?, ?, ?, ?)',
      [name, email, studentId, hashedPassword, role]
    );

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Added user: ${name} (${email})`
    ]);

    connection.release();
    res.json({ success: true, message: 'User added successfully' });
  } catch (error) {
    console.error('Add user error:', error.message);
    res.json({ success: false, message: 'Server error adding user' });
  }
});

// Update User
router.put('/admin/users/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, studentId, role } = req.body;
  try {
    const connection = await pool.getConnection();
    const [existingUser] = await connection.query(
      'SELECT * FROM users WHERE (email = ? OR student_id = ?) AND id != ?',
      [email, studentId, id]
    );
    if (existingUser.length > 0) {
      connection.release();
      return res.json({ success: false, message: 'Email or Student ID already exists' });
    }

    await connection.query(
      'UPDATE users SET name = ?, email = ?, student_id = ?, role = ? WHERE id = ?',
      [name, email, studentId, role, id]
    );

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Updated user: ${name} (${email})`
    ]);

    connection.release();
    res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    console.error('Update user error:', error.message);
    res.json({ success: false, message: 'Server error updating user' });
  }
});

// Delete User
router.delete('/admin/users/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [user] = await connection.query('SELECT name, email FROM users WHERE id = ?', [id]);
    if (user.length === 0) {
      connection.release();
      return res.json({ success: false, message: 'User not found' });
    }

    await connection.query('DELETE FROM users WHERE id = ?', [id]);

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Deleted user: ${user[0].name} (${user[0].email})`
    ]);

    connection.release();
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error.message);
    res.json({ success: false, message: 'Server error deleting user' });
  }
});

// Fetch Exams
router.get('/admin/exams', authenticateAdmin, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [exams] = await connection.query(`
      SELECT e.*, c.name AS courseName
      FROM exams e
      JOIN courses c ON e.course_id = c.id
    `);
    connection.release();
    res.json({ success: true, data: exams });
  } catch (error) {
    console.error('Fetch exams error:', error.message);
    res.json({ success: false, message: 'Server error fetching exams' });
  }
});

// Add Exam
router.post('/admin/exams', authenticateAdmin, async (req, res) => {
  const { title, type, courseId, date, time, duration, venue, minAttendance, requirePayment } = req.body;
  try {
    const connection = await pool.getConnection();
    await connection.query(
      'INSERT INTO exams (title, type, course_id, date, time, duration, venue, min_attendance, require_payment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, type, courseId, date, time, duration, venue, minAttendance, requirePayment]
    );

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Created exam: ${title}`
    ]);

    connection.release();
    res.json({ success: true, message: 'Exam created successfully' });
  } catch (error) {
    console.error('Add exam error:', error.message);
    res.json({ success: false, message: 'Server error creating exam' });
  }
});

// Fetch Courses
router.get('/admin/courses', authenticateAdmin, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [courses] = await connection.query('SELECT id, name, code FROM courses');
    connection.release();
    res.json({ success: true, data: courses });
  } catch (error) {
    console.error('Fetch courses error:', error.message);
    res.json({ success: false, message: 'Server error fetching courses' });
  }
});

// Add Course
router.post('/admin/courses', authenticateAdmin, async (req, res) => {
  const { name, code } = req.body;
  try {
    const connection = await pool.getConnection();
    const [existingCourse] = await connection.query('SELECT * FROM courses WHERE code = ?', [code]);
    if (existingCourse.length > 0) {
      connection.release();
      return res.json({ success: false, message: 'Course code already exists' });
    }

    await connection.query('INSERT INTO courses (name, code) VALUES (?, ?)', [name, code]);

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Added course: ${name} (${code})`
    ]);

    connection.release();
    res.json({ success: true, message: 'Course added successfully' });
  } catch (error) {
    console.error('Add course error:', error.message);
    res.json({ success: false, message: 'Server error adding course' });
  }
});

// Fetch Payments
router.get('/admin/payments', authenticateAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    const connection = await pool.getConnection();
    let query = `
      SELECT p.id, u.name AS studentName, u.email, u.student_id AS studentId, e.title AS examTitle, p.amount, p.status, p.payment_date AS date
      FROM payments p
      JOIN users u ON p.user_id = u.id
      JOIN exams e ON p.exam_id = e.id
    `;
    const params = [];
    if (status !== 'all') {
      query += ' WHERE p.status = ?';
      params.push(status);
    }
    const [payments] = await connection.query(query, params);
    connection.release();
    res.json({ success: true, data: payments });
  } catch (error) {
    console.error('Fetch payments error:', error.message);
    res.json({ success: false, message: 'Server error fetching payments' });
  }
});

// Generate Hall Tickets (Bulk)
router.post('/admin/hall-tickets/bulk', authenticateAdmin, async (req, res) => {
  const { examId, studentIds } = req.body;
  try {
    const connection = await pool.getConnection();
    for (const studentId of studentIds) {
      const [existingTicket] = await connection.query(
        'SELECT * FROM hall_tickets WHERE user_id = ? AND exam_id = ?',
        [studentId, examId]
      );
      if (existingTicket.length === 0) {
        // Placeholder for ticket URL (in a real system, generate a PDF or unique URL)
        const ticketUrl = `http://localhost:3000/tickets/${studentId}_${examId}.pdf`;
        await connection.query(
          'INSERT INTO hall_tickets (user_id, exam_id, ticket_url) VALUES (?, ?, ?)',
          [studentId, examId, ticketUrl]
        );
      }
    }

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Generated hall tickets for exam ID: ${examId}`
    ]);

    connection.release();
    res.json({ success: true, message: 'Hall tickets generated successfully' });
  } catch (error) {
    console.error('Generate hall tickets error:', error.message);
    res.json({ success: false, message: 'Server error generating hall tickets' });
  }
});

// Fetch Hall Tickets
router.get('/admin/hall-tickets', authenticateAdmin, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [tickets] = await connection.query(`
      SELECT h.id, u.name AS studentName, u.student_id AS studentId, e.title AS examTitle, h.exam_id AS examId
      FROM hall_tickets h
      JOIN users u ON h.user_id = u.id
      JOIN exams e ON h.exam_id = e.id
    `);
    connection.release();
    res.json({ success: true, data: tickets });
  } catch (error) {
    console.error('Fetch hall tickets error:', error.message);
    res.json({ success: false, message: 'Server error fetching hall tickets' });
  }
});

// Download Hall Ticket
router.get('/admin/hall-tickets/:studentId', authenticateAdmin, async (req, res) => {
  const { studentId } = req.params;
  const { examId } = req.query;
  try {
    const connection = await pool.getConnection();
    const [ticket] = await connection.query(
      'SELECT ticket_url FROM hall_tickets WHERE user_id = ? AND exam_id = ?',
      [studentId, examId]
    );
    if (ticket.length === 0) {
      connection.release();
      return res.json({ success: false, message: 'Hall ticket not found' });
    }
    connection.release();
    res.json({ success: true, data: { url: ticket[0].ticket_url } });
  } catch (error) {
    console.error('Download hall ticket error:', error.message);
    res.json({ success: false, message: 'Server error downloading hall ticket' });
  }
});

// Upload Result
router.post('/admin/results', authenticateAdmin, async (req, res) => {
  const { studentId, examId, marks, grade } = req.body;
  try {
    const connection = await pool.getConnection();
    const [user] = await connection.query('SELECT id FROM users WHERE student_id = ?', [studentId]);
    if (user.length === 0) {
      connection.release();
      return res.json({ success: false, message: 'Student not found' });
    }

    const [existingResult] = await connection.query(
      'SELECT * FROM results WHERE user_id = ? AND exam_id = ?',
      [user[0].id, examId]
    );
    if (existingResult.length > 0) {
      connection.release();
      return res.json({ success: false, message: 'Result already uploaded for this student and exam' });
    }

    await connection.query(
      'INSERT INTO results (user_id, exam_id, marks, grade) VALUES (?, ?, ?, ?)',
      [user[0].id, examId, marks, grade]
    );

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Uploaded result for student ID: ${studentId}, exam ID: ${examId}`
    ]);

    connection.release();
    res.json({ success: true, message: 'Result uploaded successfully' });
  } catch (error) {
    console.error('Upload result error:', error.message);
    res.json({ success: false, message: 'Server error uploading result' });
  }
});

// Fetch Results
router.get('/admin/results', authenticateAdmin, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [results] = await connection.query(`
      SELECT r.id, u.student_id AS studentId, e.title AS examTitle, r.marks, r.grade
      FROM results r
      JOIN users u ON r.user_id = u.id
      JOIN exams e ON r.exam_id = e.id
    `);
    connection.release();
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Fetch results error:', error.message);
    res.json({ success: false, message: 'Server error fetching results' });
  }
});

// Add Question Set
router.post('/admin/question-bank', authenticateAdmin, async (req, res) => {
  const { name, courseId, type } = req.body;
  try {
    const connection = await pool.getConnection();
    await connection.query(
      'INSERT INTO question_sets (name, course_id, type) VALUES (?, ?, ?)',
      [name, courseId, type]
    );

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Added question set: ${name}`
    ]);

    connection.release();
    res.json({ success: true, message: 'Question set added successfully' });
  } catch (error) {
    console.error('Add question set error:', error.message);
    res.json({ success: false, message: 'Server error adding question set' });
  }
});

// Fetch Question Bank
router.get('/admin/question-bank', authenticateAdmin, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [sets] = await connection.query(`
      SELECT q.id, q.name, c.name AS courseName, q.type
      FROM question_sets q
      JOIN courses c ON q.course_id = c.id
    `);
    connection.release();
    res.json({ success: true, data: sets });
  } catch (error) {
    console.error('Fetch question bank error:', error.message);
    res.json({ success: false, message: 'Server error fetching question bank' });
  }
});

// Send Notification
router.post('/admin/notifications', authenticateAdmin, async (req, res) => {
  const { recipients, message } = req.body;
  try {
    const connection = await pool.getConnection();
    await connection.query('INSERT INTO notifications (recipients, message) VALUES (?, ?)', [
      recipients,
      message
    ]);

    // Fetch recipients' emails
    let query = 'SELECT email FROM users WHERE role = "student"';
    const params = [];
    if (recipients === 'paid' || recipients === 'unpaid') {
      query += ' AND id IN (SELECT user_id FROM payments WHERE status = ?)';
      params.push(recipients);
    }
    const [users] = await connection.query(query, params);

    // Send emails
    for (const user of users) {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: 'AU Exam Portal Notification',
        text: message,
      };
      await transporter.sendMail(mailOptions);
    }

    // Log action
    await connection.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [
      req.user.id,
      `Sent notification to ${recipients} students`
    ]);

    connection.release();
    res.json({ success: true, message: 'Notification sent successfully' });
  } catch (error) {
    console.error('Send notification error:', error.message);
    res.json({ success: false, message: 'Server error sending notification' });
  }
});

// Fetch Audit Log
router.get('/admin/audit-log', authenticateAdmin, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [logs] = await connection.query(`
      SELECT a.id, a.action, a.timestamp
      FROM audit_logs a
      JOIN users u ON a.user_id = u.id
      WHERE u.role = 'admin'
    `);
    connection.release();
    res.json({ success: true, data: logs });
  } catch (error) {
    console.error('Fetch audit log error:', error.message);
    res.json({ success: false, message: 'Server error fetching audit log' });
  }
});

module.exports = router;