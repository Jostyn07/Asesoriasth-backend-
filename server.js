// server.js
require('dotenv').config();
const { Readable } = require('stream'); 
const express = require('express');
const { google } = require('googleapis');
const multer = require('multer');
const cors = require('cors'); 
const fs = require('fs');
const path = require('path');
const { parse } = require('url');

const SPREADSHEET_ID = "1T8YifEIUU7a6ugf_Xn5_1edUUMoYfM9loDuOQU1u2-8";
const SHEET_NAME_OBAMACARE = "Pólizas";
const SHEET_NAME_CIGNA = "Cigna Complementario";
const SHEET_NAME_PAGOS = "Pagos";
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

let auth;try {
auth = new google.auth.GoogleAuth({
scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
});
console.log('Autenticación de Google configurada.');
} catch (error) {
console.error('Error al configurar la autenticación de Google:', error);
process.exit(1);
}

const app = express();
const upload = multer();
const allowedOrigins = ["https://asesoriasth.com", "http://127.0.0.1:5500", "https://asesoriasth.com/formulario.html"];
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("No autorizado por CORS"));
        }
    },
    credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

async function getAuthenticatedClient() {
  const authClient = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'Documentos.json'), // O 'credentials.json' si así se llama tu archivo
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
  return await authClient.getClient();
}

// Helper para obtener el sheetId por su nombre
async function getSheetId(sheets, spreadsheetId, sheetName) {
    const res = await sheets.spreadsheets.get({
        spreadsheetId
    });
    const sheet = res.data.sheets.find(s => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Hoja de cálculo no encontrada: ${sheetName}`);
    return sheet.properties.sheetId;
}

// Endpoint unificado para recibir todo el formulario
app.post('/api/upload-files', upload.array('files'), async (req, res) => {
    try {
        const { folderId, nombre, apellidos, telefono} = req.body;
        if (!folderId) {
          return res.status(400).json({ error: 'El ID de la carpeta es requerido.' });
        }

        const authClient = await getAuthenticatedClient();
        const drive = google.drive({ version: 'v3', auth: authClient });

        const uploadedFileLinks = [];
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const fileMetadata = {
                    name: file.originalname,
                    parents: [folderId]
                };
                const media = {
                    mimeType: file.mimetype,
                    body: Readable.from(file.buffer)
                };
                const response = await drive.files.create({
                    resource: fileMetadata,
                    media: media,
                    fields: 'id, webViewLink',
                    supportsAllDrives: true
                });
                uploadedFileLinks.push(response.data.webViewLink);
            }
        }

        res.status(200).json({
            message: 'Archivos subidos exitosamente',
            fileLinks: uploadedFileLinks
        });
    } catch (error) {
        console.error('Error al subir archivos:', error);
        res.status(500).json({ error: 'Error al subir archivos' });
    }
});

// Endpoint para crear carpeta en Google Drive
app.post('/api/create-folder', async (req, res) => {
  console.log('Solicitud recibida para crear carpeta:', req.body);
  try {
    const folderName = req.body.folderName;
    if (!folderName) {
      return res.status(400).send('El nombre de la carpeta es requerido.');
    }

    const authClient = await getAuthenticatedClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [DRIVE_FOLDER_ID]
    };

    const response = await drive.files.create({
      resource: folderMetadata,
      fields: 'id',
      supportsAllDrives: true // <--- IMPORTANTE para unidades compartidas
    });

    console.log('Carpeta creada con ID:', response.data.id);
    res.status(201).send({
      message: 'Carpeta creada exitosamente',
      folderId: response.data.id,
    });

  } catch (error) {
    console.error('Error al crear la carpeta:', error.errors || error.message || error);
    res.status(500).send('Error interno del servidor');
  }
});

function usToIso(us) {
    if (!us) return "";
    const [m, d, y] = us.split("/");
    return `${y}-${m}-${d}`;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
