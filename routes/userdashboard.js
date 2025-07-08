const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs').promises;
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

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Middleware to verify JWT and student role
const authenticateStudent = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'student') {
      return res.status(403).json({ success: false, message: 'Access denied: Students only' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Fetch User Profile
router.get('/user/profile', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query(
      'SELECT id, name, email, student_id AS studentId, role, profile_image AS profileImage FROM users WHERE id = ?',
      [req.user.id]
    );
    connection.release();
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, data: users[0] });
  } catch (error) {
    console.error('Fetch profile error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching profile' });
  }
});

// Upload Profile Image
router.post('/user/profile/image', authenticateStudent, async (req, res) => {
  try {
    if (!req.files || !req.files.profileImage) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }
    const file = req.files.profileImage;
    if (!file.mimetype.startsWith('image/')) {
      return res.status(400).json({ success: false, message: 'Invalid image format' });
    }

    const uploadDir = path.join(__dirname, '../uploads/profiles');
    await fs.mkdir(uploadDir, { recursive: true });
    const filename = `${req.user.id}_${Date.now()}${path.extname(file.name)}`;
    const filePath = path.join(uploadDir, filename);
    await file.mv(filePath);

    const imageUrl = `/uploads/profiles/${filename}`;
    const connection = await pool.getConnection();
    await connection.query(
      'UPDATE users SET profile_image = ? WHERE id = ?',
      [imageUrl, req.user.id]
    );
    connection.release();

    res.json({ success: true, data: { imageUrl } });
  } catch (error) {
    console.error('Upload profile image error:', error.message);
    res.status(500).json({ success: false, message: 'Server error uploading image' });
  }
});

// Fetch Available Exams
router.get('/user/exams/available', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [attendanceRows] = await connection.query(
      'SELECT course_id, attendance_percentage FROM attendance WHERE user_id = ?',
      [req.user.id]
    );
    const attendanceMap = new Map(attendanceRows.map(row => [row.course_id, row.attendance_percentage]));

    const [exams] = await connection.query(`
      SELECT e.id, e.title, e.type, c.name AS courseName, e.date, e.time, e.venue, 
             e.min_attendance AS minAttendance, e.fee, e.require_payment AS requirePayment,
             (SELECT COUNT(*) FROM payments p WHERE p.user_id = ? AND p.exam_id = e.id AND p.status = 'paid') AS isPaid,
             (SELECT COUNT(*) FROM payments p WHERE p.user_id = ? AND p.exam_id = e.id) AS isRegistered
      FROM exams e
      JOIN courses c ON e.course_id = c.id
      WHERE e.date >= CURDATE()
    `, [req.user.id, req.user.id]);

    const availableExams = exams.map(exam => ({
      id: exam.id,
      title: exam.title,
      type: exam.type,
      courseName: exam.courseName,
      date: exam.date.toISOString().split('T')[0],
      time: exam.time,
      venue: exam.venue,
      fee: exam.fee,
      eligible: (attendanceMap.get(exam.course_id) || 0) >= exam.minAttendance && exam.isRegistered === 0,
    }));

    connection.release();
    res.json({ success: true, data: availableExams });
  } catch (error) {
    console.error('Fetch available exams error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching exams' });
  }
});

// Fetch Registered Exams
router.get('/user/exams/registered', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [exams] = await connection.query(`
      SELECT e.id, e.title, e.type, c.name AS courseName, e.date, e.time, e.venue
      FROM exams e
      JOIN courses c ON e.course_id = c.id
      JOIN payments p ON p.exam_id = e.id
      WHERE p.user_id = ?
    `, [req.user.id]);
    const formattedExams = exams.map(exam => ({
      ...exam,
      date: exam.date.toISOString().split('T')[0],
    }));
    connection.release();
    res.json({ success: true, data: formattedExams });
  } catch (error) {
    console.error('Fetch registered exams error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching registered exams' });
  }
});

// Register and Pay for Exam
router.post('/user/exams/register', authenticateStudent, async (req, res) => {
  const { examId, amount } = req.body;
  if (!examId || typeof amount !== 'number') {
    return res.status(400).json({ success: false, message: 'Invalid exam ID or amount' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [exam] = await connection.query(
      'SELECT course_id, min_attendance, fee, require_payment, title FROM exams WHERE id = ? AND date >= CURDATE()',
      [examId]
    );
    if (exam.length === 0) {
      throw new Error('Exam not found or registration closed');
    }
    if (exam[0].fee !== amount) {
      throw new Error('Invalid payment amount');
    }

    const [attendance] = await connection.query(
      'SELECT attendance_percentage FROM attendance WHERE user_id = ? AND course_id = ?',
      [req.user.id, exam[0].course_id]
    );
    if (!attendance.length || attendance[0].attendance_percentage < exam[0].min_attendance) {
      throw new Error('Insufficient attendance');
    }

    const [existingPayment] = await connection.query(
      'SELECT id FROM payments WHERE user_id = ? AND exam_id = ?',
      [req.user.id, examId]
    );
    if (existingPayment.length > 0) {
      throw new Error('Already registered for this exam');
    }

    await connection.query(
      'INSERT INTO payments (user_id, exam_id, amount, status, payment_date) VALUES (?, ?, ?, ?, NOW())',
      [req.user.id, examId, amount, exam[0].require_payment ? 'paid' : 'free']
    );

    await connection.query(
      'INSERT INTO hall_tickets (user_id, exam_id, issue_date) VALUES (?, ?, NOW())',
      [req.user.id, examId]
    );

    await connection.commit();
    connection.release();

    // Send payment confirmation email
    const [user] = await pool.query('SELECT email, name FROM users WHERE id = ?', [req.user.id]);
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user[0].email,
      subject: 'Payment Confirmation - Alliance University Exam Registration',
      html: `
        <h2>Payment Confirmation</h2>
        <p>Dear ${user[0].name},</p>
        <p>Your registration and payment for the following exam has been successfully processed:</p>
        <ul>
          <li><strong>Exam:</strong> ${exam[0].title}</li>
          <li><strong>Amount:</strong> $${amount.toFixed(2)}</li>
          <li><strong>Date:</strong> ${new Date().toLocaleDateString()}</li>
        </ul>
        <p>Thank you for your payment.</p>
        <p>Regards,<br>Alliance University</p>
      `,
    });

    res.json({ success: true, message: 'Exam registered and payment processed successfully' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    console.error('Register and pay error:', error.message);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Send Payment Email (for manual trigger or retry)
router.post('/user/payments/email', authenticateStudent, async (req, res) => {
  const { examId, amount, examTitle } = req.body;
  if (!examId || !amount || !examTitle) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  try {
    const connection = await pool.getConnection();
    const [payment] = await connection.query(
      'SELECT id FROM payments WHERE user_id = ? AND exam_id = ? AND amount = ? AND status = "paid"',
      [req.user.id, examId, amount]
    );
    if (payment.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Payment not found or not paid' });
    }

    const [user] = await connection.query('SELECT email, name FROM users WHERE id = ?', [req.user.id]);
    connection.release();

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user[0].email,
      subject: 'Payment Confirmation - Alliance University Exam Registration',
      html: `
        <h2>Payment Confirmation</h2>
        <p>Dear ${user[0].name},</p>
        <p>Your payment for the following exam has been successfully processed:</p>
        <ul>
          <li><strong>Exam:</strong> ${examTitle}</li>
          <li><strong>Amount:</strong> $${amount.toFixed(2)}</li>
          <li><strong>Date:</strong> ${new Date().toLocaleDateString()}</li>
        </ul>
        <p>Thank you for your payment.</p>
        <p>Regards,<br>Alliance University</p>
      `,
    });

    res.json({ success: true, message: 'Payment confirmation email sent' });
  } catch (error) {
    console.error('Send payment email error:', error.message);
    res.status(500).json({ success: false, message: 'Server error sending email' });
  }
});

// Fetch Payments
router.get('/user/payments', authenticateStudent, async (req, res) => {
  const { status } = req.query;
  try {
    const connection = await pool.getConnection();
    let query = `
      SELECT p.id, e.title AS examTitle, p.amount, p.status, p.payment_date AS date, e.id AS examId
      FROM payments p
      JOIN exams e ON p.exam_id = e.id
      WHERE p.user_id = ?
    `;
    const params = [req.user.id];
    if (status !== 'all') {
      query += ' AND p.status = ?';
      params.push(status);
    }
    const [payments] = await connection.query(query, params);
    const formattedPayments = payments.map(payment => ({
      ...payment,
      date: payment.date ? payment.date.toISOString().split('T')[0] : null,
    }));
    connection.release();
    res.json({ success: true, data: formattedPayments });
  } catch (error) {
    console.error('Fetch payments error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching payments' });
  }
});

// Fetch Hall Tickets
router.get('/user/hall-tickets', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [tickets] = await connection.query(`
      SELECT h.id, e.title AS examTitle, u.student_id AS studentId, h.exam_id AS examId,
             e.date, e.time, e.venue
      FROM hall_tickets h
      JOIN exams e ON h.exam_id = e.id
      JOIN users u ON h.user_id = u.id
      WHERE h.user_id = ?
    `, [req.user.id]);
    const formattedTickets = tickets.map(ticket => ({
      ...ticket,
      date: ticket.date.toISOString().split('T')[0],
    }));
    connection.release();
    res.json({ success: true, data: formattedTickets });
  } catch (error) {
    console.error('Fetch hall tickets error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching hall tickets' });
  }
});

// Fetch Results
router.get('/user/results', authenticateStudent, async (req, res) => {
  const { type } = req.query;
  try {
    const connection = await pool.getConnection();
    let query = `
      SELECT r.id, e.title AS examTitle, r.marks, r.grade
      FROM results r
      JOIN exams e ON r.exam_id = e.id
      WHERE r.user_id = ?
    `;
    const params = [req.user.id];
    if (type !== 'all') {
      query += ' AND e.type = ?';
      params.push(type);
    }
    const [results] = await connection.query(query, params);
    connection.release();
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Fetch results error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching results' });
  }
});

// Fetch Timetable
router.get('/user/timetable', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [exams] = await connection.query(`
      SELECT e.id, e.title, e.type, c.name AS courseName, e.date, e.time, e.venue
      FROM exams e
      JOIN courses c ON e.course_id = c.id
      JOIN payments p ON p.exam_id = e.id
      WHERE p.user_id = ? AND p.status = 'paid'
    `, [req.user.id]);
    const formattedExams = exams.map(exam => ({
      ...exam,
      date: exam.date.toISOString().split('T')[0],
    }));
    connection.release();
    res.json({ success: true, data: formattedExams });
  } catch (error) {
    console.error('Fetch timetable error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching timetable' });
  }
});

// Fetch Notifications
router.get('/user/notifications', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [notifications] = await connection.query(`
      SELECT id, message, sent_at AS date
      FROM notifications
      WHERE recipients = 'all'
         OR (recipients = 'paid' AND EXISTS (
            SELECT 1 FROM payments p WHERE p.user_id = ? AND p.status = 'paid'
         ))
         OR (recipients = 'unpaid' AND EXISTS (
            SELECT 1 FROM payments p WHERE p.user_id = ? AND p.status = 'unpaid'
         ))
      ORDER BY sent_at DESC
    `, [req.user.id, req.user.id]);
    const formattedNotifications = notifications.map(notification => ({
      ...notification,
      date: notification.date.toISOString().split('T')[0],
    }));
    connection.release();
    res.json({ success: true, data: formattedNotifications });
  } catch (error) {
    console.error('Fetch notifications error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching notifications' });
  }
});

// Fetch Attendance
router.get('/user/attendance', authenticateStudent, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [attendance] = await connection.query(`
      SELECT c.name AS courseName, a.attendance_percentage AS attendancePercentage,
             a.attendance_percentage >= e.min_attendance AS eligible
      FROM attendance a
      JOIN courses c ON a.course_id = c.id
      JOIN exams e ON e.course_id = c.id
      WHERE a.user_id = ?
    `, [req.user.id]);
    connection.release();
    res.json({ success: true, data: attendance });
  } catch (error) {
    console.error('Fetch attendance error:', error.message);
    res.status(500).json({ success: false, message: 'Server error fetching attendance' });
  }
});

module.exports = router;