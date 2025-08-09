// server.js
import express from 'express';
import session from 'express-session';
import { google } from 'googleapis';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import cors from 'cors';

dotenv.config();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  CARPARTS_FOLDER_ID,
  SESSION_SECRET,
  PORT = 3000
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI || !CARPARTS_FOLDER_ID || !SESSION_SECRET) {
  console.error('Missing required env vars. See README in code.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // set true if using https
}));

// serve static admin page & assets from "public"
app.use(express.static('public'));

// Multer config for handling uploads
const upload = multer({ storage: multer.memoryStorage() });

// create OAuth2 client builder (we will create per-request)
function createOAuthClient() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

// Helper: ensure user is authenticated (has tokens in session)
function ensureAuth(req, res, next) {
  if (req.session.tokens) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

/**
 * 1) Begin OAuth (admin clicks sign-in)
 */
app.get('/auth/google', (req, res) => {
  const oAuth2Client = createOAuthClient();
  const scopes = [
    'https://www.googleapis.com/auth/drive' // full drive access (upload/delete)
  ];
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });
  res.redirect(url);
});

/**
 * 2) OAuth callback
 */
app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    const oAuth2Client = createOAuthClient();
    const { tokens } = await oAuth2Client.getToken(code);
    // store tokens in session (for demo). In production store securely.
    req.session.tokens = tokens;
    res.redirect('/admin'); // serve admin page
  } catch (err) {
    console.error(err);
    res.status(500).send('OAuth failed');
  }
});

/**
 * get authorized drive client using session tokens
 */
function getDriveClientFromSession(req) {
  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials(req.session.tokens);
  const drive = google.drive({ version: 'v3', auth: oAuth2Client });
  return { drive, auth: oAuth2Client };
}

/**
 * 3) Upload new part (create folder, upload image and details.txt)
 * form fields: partName (text), details (string), image (file)
 */
app.post('/api/upload', ensureAuth, upload.single('image'), async (req, res) => {
  try {
    const { partName, details } = req.body;
    if (!partName) return res.status(400).json({ error: 'partName required' });

    const { drive } = getDriveClientFromSession(req);

    // 1) create folder under CARPARTS_FOLDER_ID
    const folderMetadata = {
      name: partName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [CARPARTS_FOLDER_ID]
    };

    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id, name'
    });

    const folderId = folder.data.id;

    // 2) upload image (if provided)
    if (req.file) {
      const mimeType = req.file.mimetype || 'image/jpeg';
      await drive.files.create({
        requestBody: {
          name: req.file.originalname,
          parents: [folderId],
          mimeType
        },
        media: {
          mimeType,
          body: Buffer.from(req.file.buffer)
        },
        fields: 'id, name'
      });
    }

    // 3) upload details.txt
    if (details) {
      await drive.files.create({
        requestBody: {
          name: 'details.txt',
          parents: [folderId],
          mimeType: 'text/plain'
        },
        media: {
          mimeType: 'text/plain',
          body: Buffer.from(details, 'utf8')
        },
        fields: 'id, name'
      });
    }

    res.json({ success: true, folderId });
  } catch (err) {
    console.error('upload error', err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

/**
 * 4) List parts (folders under CARPARTS folder)
 */
app.get('/api/parts', ensureAuth, async (req, res) => {
  try {
    const { drive } = getDriveClientFromSession(req);

    // list folders inside CARPARTS_FOLDER_ID
    const r = await drive.files.list({
      q: `'${CARPARTS_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 1000
    });

    const folders = r.data.files || [];
    const parts = [];

    for (const f of folders) {
      // list files inside that folder (image and details.txt)
      const filesRes = await drive.files.list({
        q: `'${f.id}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType)',
        pageSize: 50
      });

      let imageFile = null;
      let detailsFile = null;

      for (const file of filesRes.data.files) {
        if (file.mimeType && file.mimeType.startsWith('image/')) {
          imageFile = file;
        } else if (file.name && file.name.toLowerCase().includes('details')) {
          detailsFile = file;
        } else if (file.mimeType === 'text/plain' && !detailsFile) {
          detailsFile = file;
        }
      }

      let detailsText = '';
      if (detailsFile) {
        const txt = await drive.files.get({
          fileId: detailsFile.id,
          alt: 'media'
        });
        detailsText = typeof txt.data === 'string' ? txt.data : JSON.stringify(txt.data);
      }

      // create public access link via "webContentLink" isn't available unless file is shared;
      // we'll use the drive "uc?id=" pattern which works if the signed-in user can access the file.
      const imageUrl = imageFile ? `https://drive.google.com/uc?id=${imageFile.id}` : null;
      parts.push({
        id: f.id,
        name: f.name,
        imageUrl,
        details: detailsText
      });
    }

    res.json(parts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list parts', details: err.message });
  }
});

/**
 * 5) Delete a part folder (move to trash)
 */
app.post('/api/delete', ensureAuth, async (req, res) => {
  try {
    const { folderId } = req.body;
    if (!folderId) return res.status(400).json({ error: 'folderId required' });

    const { drive } = getDriveClientFromSession(req);

    // move folder to trash
    await drive.files.update({
      fileId: folderId,
      requestBody: { trashed: true }
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete', details: err.message });
  }
});

/**
 * 6) Logout
 */
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

// Serve admin page at /admin (index in public)
app.get('/admin', (req, res) => {
  const loggedIn = !!req.session.tokens;
  // serve static file
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
