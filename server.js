require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const cors = require('cors');
const multer = require('multer');
const excelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); 

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_attendance_key';

// ==========================================
// 1. CLOUDINARY CONFIGURATION (Face Detection & Enhancement)
// ==========================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dppiuypop",
  api_key: process.env.CLOUDINARY_API_KEY || "412712715735329",
  api_secret: process.env.CLOUDINARY_API_SECRET || "m04IUY0-awwtr4YoS-1xvxOOIzU",
});

function uploadBufferToCloudinary(buffer, folder = 'security_visitors') {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder,
        faces: true, 
        transformation: [
          { effect: "improve" },        
          { effect: "brightness:30" },  
          { crop: "limit", width: 800, height: 800 } 
        ]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// ==========================================
// 2. MONGODB CONNECTION
// ==========================================
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://abc:1234@cluster0.nnjwt12.mongodb.net/security';
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(MONGO_URL);
    isConnected = true;
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    throw err;
  }
}

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    return res.status(500).json({ error: "Database connection failed" });
  }
});

// ==========================================
// 3. SECURITY MIDDLEWARE (JWT)
// ==========================================
const authMiddleware = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) return res.status(401).json({ error: "Access Denied: No token provided" });

  const token = authHeader.split(' ')[1];
  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.facultyId = verified.id; 
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ==========================================
// 4. MONGODB SCHEMAS & MODELS
// ==========================================
const facultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  department: String
});
const Faculty = mongoose.models.Faculty || mongoose.model('Faculty', facultySchema);

const studentSchema = new mongoose.Schema({
  name: String,
  rollNumber: { type: String, unique: true },
  department: String,
  section: String
});
const Student = mongoose.models.Student || mongoose.model('Student', studentSchema);

const sessionSchema = new mongoose.Schema({
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
  department: { type: String, required: true }, 
  section: { type: String, required: true },    
  location: { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
  allowedRadius: { type: Number, required: true },
  startTime: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  isActive: { type: Boolean, default: true }
});
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const attendanceSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  studentName: String,
  rollNumber: String,
  department: String, 
  section: String,    
  deviceFingerprint: String,
  ipAddress: String,  
  capturedImageUrl: String,
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['Present', 'Denied'], default: 'Present' }
});
const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema);

// ==========================================
// 5. GPS MATH HELPER FUNCTION
// ==========================================
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRadians = (deg) => deg * (Math.PI / 180);
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

// ==========================================
// 6. API ROUTES
// ==========================================

app.post('/api/faculty/register', async (req, res) => {
  try {
    const { name, email, password, department } = req.body;
    const existingFaculty = await Faculty.findOne({ email });
    if (existingFaculty) return res.status(400).json({ error: "Email already registered" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await Faculty.create({ name, email, password: hashedPassword, department });
    res.status(201).json({ message: "Registration successful" });
  } catch (error) {
    res.status(500).json({ error: "Registration failed", details: error.message });
  }
});

app.post('/api/faculty/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const faculty = await Faculty.findOne({ email });
    if (!faculty) return res.status(404).json({ error: "Faculty not found" });

    const isMatch = await bcrypt.compare(password, faculty.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: faculty._id }, JWT_SECRET, { expiresIn: '8h' });

    res.status(200).json({ 
      message: "Login successful", 
      token,
      name: faculty.name,
      department: faculty.department
    });
  } catch (error) {
    res.status(500).json({ error: "Login failed", details: error.message });
  }
});

app.post('/api/faculty/start-session', authMiddleware, async (req, res) => {
  try {
    const { department, section, lat, lng, durationMinutes, allowedRadius } = req.body;
    const expiresAt = new Date(Date.now() + (durationMinutes || 5) * 60000);

    const session = await Session.create({
      facultyId: req.facultyId, 
      department: department || "ALL", 
      section: section || "ALL",
      location: { lat, lng },
      allowedRadius: allowedRadius || 50, 
      expiresAt,
      isActive: true
    });

    res.status(201).json({
      message: "Session started successfully",
      sessionId: session._id,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to start session", details: error.message });
  }
});

// --- STUDENT: Mark Attendance ---
app.post('/api/student/mark-attendance', upload.single('image'), async (req, res) => {
  try {
    const { sessionId, rollNumber, name, department, section, lat, lng, deviceFingerprint } = req.body;
    const imageBuffer = req.file?.buffer;
    const studentIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!imageBuffer) return res.status(400).json({ error: "Image file is required" });

    // 1. Session Validations
    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (new Date() > session.expiresAt || !session.isActive) {
      return res.status(403).json({ error: "Session has expired" });
    }

    // 2. Strict Multiple Submissions Block
    const existingEntry = await Attendance.findOne({
      sessionId,
      $or: [ { rollNumber }, { deviceFingerprint } ]
    });

    if (existingEntry) {
      if (existingEntry.rollNumber === rollNumber) {
        return res.status(409).json({ error: "Attendance already marked for this roll number." });
      } else {
        return res.status(403).json({ error: "STRICT BLOCK: This device has already been used to mark attendance for someone else." });
      }
    }

    // 3. GPS Radius Validation (UPDATED INDOOR DRIFT TOLERANCE)
    const distance = getDistanceInMeters(session.location.lat, session.location.lng, parseFloat(lat), parseFloat(lng));
    
    // Increased buffer to 50 meters to account for heavy concrete labs blocking signals
    const GPS_DRIFT_TOLERANCE = 50; 
    const effectiveRadius = session.allowedRadius + GPS_DRIFT_TOLERANCE;

    if (distance > effectiveRadius) {
      // Improved error message to reflect the true calculation
      return res.status(403).json({ 
        error: `Access Denied: You are ${Math.round(distance)}m away. Maximum allowed range (including indoor buffer) is ${effectiveRadius}m.` 
      });
    }

    // 4. Cloudinary Night-Vision Upload & Face Validation
    const uploadResult = await uploadBufferToCloudinary(imageBuffer, 'attendance_captures');

    if (!uploadResult.faces || uploadResult.faces.length === 0) {
      return res.status(400).json({ error: "No face detected in the environment. Please ensure good lighting." });
    }
    if (uploadResult.faces.length > 1) {
      return res.status(400).json({ error: "Multiple faces detected. Only you should be in the frame." });
    }

    // 5. Save Verified Data
    const attendanceRecord = await Attendance.create({
      sessionId,
      studentName: name,
      rollNumber,
      department: department.toUpperCase(),
      section: section.toUpperCase(),
      deviceFingerprint,
      ipAddress: studentIp,
      capturedImageUrl: uploadResult.secure_url,
      status: 'Present'
    });

    res.status(200).json({ message: "Attendance Verified & Saved Successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to mark attendance", details: error.message });
  }
});

app.get('/api/faculty/dashboard/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const attendees = await Attendance.find({ sessionId }).sort({ department: 1, section: 1, timestamp: 1 });

    const segregatedData = attendees.reduce((acc, curr) => {
      const groupKey = `${curr.department} - Section ${curr.section}`;
      if (!acc[groupKey]) acc[groupKey] = [];
      acc[groupKey].push({
        name: curr.studentName,
        rollNumber: curr.rollNumber,
        timestamp: curr.timestamp,
        image: curr.capturedImageUrl
      });
      return acc;
    }, {});

    res.status(200).json({
      sessionDetails: {
        targetDepartment: session.department,
        targetSection: session.section,
        isActive: new Date() < session.expiresAt && session.isActive,
      },
      totalPresent: attendees.length,
      segregatedData 
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch dashboard", details: error.message });
  }
});

app.get('/api/faculty/export-excel/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await Session.findById(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const attendees = await Attendance.find({ sessionId }).sort({ department: 1, section: 1, timestamp: 1 });
    const workbook = new excelJS.Workbook();
    const departments = [...new Set(attendees.map(a => a.department))];

    departments.forEach(dept => {
      const worksheet = workbook.addWorksheet(`${dept} Attendance`);
      worksheet.columns = [
        { header: 'S.No', key: 'sno', width: 10 },
        { header: 'Name', key: 'name', width: 25 },
        { header: 'Roll Number', key: 'rollNumber', width: 20 },
        { header: 'Section', key: 'section', width: 15 },
        { header: 'Date', key: 'date', width: 15 },
        { header: 'Time', key: 'time', width: 15 }
      ];
      worksheet.getRow(1).eachCell((cell) => { cell.font = { bold: true }; });

      let sno = 1;
      attendees.forEach((attendee) => {
        if (attendee.department === dept) {
          const attendanceDate = new Date(attendee.timestamp);
          worksheet.addRow({
            sno: sno++,
            name: attendee.studentName,
            rollNumber: attendee.rollNumber,
            section: attendee.section,
            date: attendanceDate.toLocaleDateString(),
            time: attendanceDate.toLocaleTimeString()
          });
        }
      });
    });

    if (departments.length === 0) workbook.addWorksheet('Empty Session');

    const fileName = `Session_${sessionId.toString().substring(0,6)}_Attendance.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ error: "Failed to export Excel sheet", details: error.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
}
module.exports = app;
