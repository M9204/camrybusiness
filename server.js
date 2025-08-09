// backend/server.js
import express from 'express';
import { google } from 'googleapis';
import cors from 'cors';

const app = express();
app.use(cors());

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json', // service account JSON
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

const drive = google.drive({ version: 'v3', auth });

const CARPARTS_FOLDER_ID = 'YOUR_FOLDER_ID';

async function listParts() {
  const res = await drive.files.list({
    q: `'${CARPARTS_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
  });

  let parts = [];

  for (const folder of res.data.files) {
    const filesRes = await drive.files.list({
      q: `'${folder.id}' in parents`,
      fields: 'files(id, name, mimeType)',
    });

    let imageUrl = '';
    let detailsText = '';

    for (const file of filesRes.data.files) {
      if (file.mimeType.startsWith('image/')) {
        imageUrl = `https://drive.google.com/uc?id=${file.id}`;
      } else if (file.mimeType === 'text/plain') {
        const txt = await drive.files.get({
          fileId: file.id,
          alt: 'media',
        });
        detailsText = txt.data;
      }
    }

    parts.push({
      name: folder.name,
      image: imageUrl,
      details: detailsText,
    });
  }

  return parts;
}

app.get('/api/parts', async (req, res) => {
  res.json(await listParts());
});

app.listen(3000, () => console.log('Server running'));
