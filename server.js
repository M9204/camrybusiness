// server.js (or api.js)
const express = require('express');
const { google } = require('googleapis');
const app = express();
const PORT = process.env.PORT || 3000;

// Configure Google Drive API auth (use service account or OAuth)
// This is simplified, you'll need credentials JSON and setup

const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json', // your service account JSON
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

const drive = google.drive({ version: 'v3', auth });

const CARPARTS_FOLDER_ID = 'your_carparts_folder_id_here';

app.get('/api/parts', async (req, res) => {
  try {
    // List folders in CARPARTS_FOLDER_ID
    const folders = await drive.files.list({
      q: `'${CARPARTS_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    });

    const parts = [];

    for (const folder of folders.data.files) {
      // For each part folder, get image and details
      const files = await drive.files.list({
        q: `'${folder.id}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType)',
      });

      let imageFile = files.data.files.find(f => f.mimeType.startsWith('image/'));
      let txtFile = files.data.files.find(f => f.name.endsWith('.txt'));

      // Get file content of .txt
      let details = '';
      if (txtFile) {
        const resp = await drive.files.get(
          { fileId: txtFile.id, alt: 'media' },
          { responseType: 'text' }
        );
        details = resp.data;
      }

      // Get public link or embed link for image
      // (Make sure the images are publicly shared or you generate export links)
      let imageUrl = null;
      if (imageFile) {
        imageUrl = `https://drive.google.com/uc?export=view&id=${imageFile.id}`;
      }

      parts.push({
        name: folder.name,
        imageUrl,
        details,
      });
    }

    res.json(parts);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error retrieving parts');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
