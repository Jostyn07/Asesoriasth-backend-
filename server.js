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

import { error } from 'console';
import { query } from './db.js';


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
const allowedOrigins = ["https://asesoriasth.com", "http://127.0.0.1:5500", "https://asesoriasth.com/formulario.html", "https://jostyn07.github.io/Asesoriasth-/"];
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

async.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`Intento de login para: ${email}`);

    if (!email || !password) {
        return res.status(400).json({ error: 'Falatan credenciales (correo y contraseña).' });
    }
    const sql = 'SELECT id, nommbre, email, password FROM users WHERE email = $1 AND password = $2';
    const values = [email, password];

    try {
        const user = await query(sql, values);

        if (users.length === 1) {
        const user = user[0];
        console.log(` Usuario autenticado: ${user.nombre}`);

        // En producción se debe usar un JWT
        const token = `local_auth_token_${user.id}`

        return res.status(200).json({
            message: 'Autenticación exitosa',
            token: token,
            user: {
                id: user.id,
                name: user.nombre,
                email: user.email
            }
        });        
      } else {
        console.error(`Credenciales invalidas para ${email}`);
        return res.status(401).json({ error: 'Credenciales invalidas'});  
        }
    } catch (error) {
        console.error('Error en la consulta de login:', error);
        return res.status(500).json({ error: 'Error interno del servidor al intentar iniciar sesión'})
    }
})

async function getAuthenticatedClient() {
    const credentials = JSON.parse(process.env.GOOGLE_SA_CREDENTIALS);

    const authClient = new google.aut.GoogleAuth ({
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

function cleanCurrency(values) {
    if (typeof value !== 'string') return value;
    //remueve '$' y ','
    return value.replace(/[$,]/g, '').trim(); 
}
// Endpoint para recibir y enviar los datos del formulario a Google Sheets
app.post('/api/submit-form-data', async (req, res) => {
    try {
        const data = req.body;

        // 1.Obtener cliennte autenticado de Google (Service Account)
        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        const ClientId = `CLI-${Date.now()}-${Math.random().toString(36).slice.slice(2,8).toUpperCase()}`
        const fechaRegistoUs = data.fechaRegisto || '';

        // Prepara y enviar datos de Obamacare y dependientes
        const obamacareData = [
            data.operador || '',
            fechaRegistoUs,
            data.tipoVenta || '',
            data.claveSeguidad || '',
            'Titular',
            data.nombre || '',
            data.apellidos || '',
            data.sexo || '',
            data.correo || '',
            data.telefono || '',
            data.fechaNacimiento || '',
            data.estadoMigratorio || '',
            data.ssn || '',
            cleanCurrency(data.ingresos) || '',
            data.ocupación || '',
            data.nacionalidad || '',
            data.aplica || '',
            data.cantidadDependientes || '0',
            // Dirección completa
            data.poBox ? `PO Box: ${data.poBox}` :
                `${data.direccion || ''}, ${data.casaApartamento || ''}, ${data.condado || ''}, ${data.ciudad || ''}, ${data.estado || ''}, ${data.codigoPostal || ''}`.replace(/,\s*,/g, ', ').replace(/,\s*$/, '').trim(),            
            data.compania || '',
            data.plan || '',
            cleanCurrency(data.creditoFiscal) || '',
            cleanCurrency(data.prima) || '',
            data.link || '',
            data.observacion || '' ,
            clientId,          
        ];
        
        let obamacareRows = [obamacareData];

        // Añadir dependientes
        if (data.dependents && data.dependents.length > 0) {
        data.dependents.forEach(dep => {
            obamacareRows.push([
                data.operador || '', 
                fechaRegistroUS,
                data.tipoVenta || '',
                data.claveSeguridad || '',
                dep.parentesco || '',
                dep.nombre || '',
                dep.apellido || '',
                '', // Sexo
                '', // Correo
                '', // Teléfono
                dep.fechaNacimiento || '',
                dep.estadoMigratorio || '',
                dep.ssn || '',
                '', // Ingresos
                '', // Ocupación
                '', // Nacionalidad
                dep.aplica || '',
                '', // Cantidad de dependientes
                '', // Dirección completa (vacío para dependientes)
                '', '', '', '', '', '', '', // Campos de Póliza vacíos
                clientId
            ]);
        });
        }

        // Ejecutar insercion en Sheets
        const obamacareSheetResponse = await sheets.spreadsheet.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_OBAMACARE}!A1`,
            valueInputOption: 'USER_ENTERED',
            insetDataOption: 'INSERT_ROWS',
            resource: {
                values: obamacareRows,
            },
        });
        console.log(`Datos de Obamacare y dependientes guardados en Sheets, fila(s) ${obamacareSheetResponse.data.updates.updateRange}`);
        
        // Preparar y enviar datos de cigna
        if (data.cignaPlans &&  data.cignaPlans.length > 0) {
            const cignaValues = data.cignaPlans.map((p) => [
                clientId,
                newDate.tolocaleDateString('es-ES'),
                `${data.nombre} ${data.apellido}`,
                data.telefono || '',
                data.sexo || '',
                p.fechaNacimiento || '',
                p.data.poBox ? `PO Box: ${data.poBox}` :
                    `${data.direccion || ''}, ${data.casaApartamento || ''}, ${data.condado || ''}, ${data.ciudad || ''}, ${data.estado || ''}, ${data.codigoPostal || ''}`.replace(/,\s*,/g, ', ').replace(/,\s*$/, '').trim(),            
                data.correo || '',
                data.estadoMigratorio || '',
                data.ssn || '',
                `${p.beneficiarioNombre || ''} / ${p.beneficiarioFechaNacimiento || ''} / ${p.beneficiarioDireccion || ''} / ${p.beneficiarioRelacion || ''}`,
                p.tipo || '',
                p.coberturaTipo || '',
                p.beneficio || '',
                cleanCurrency(p.beneficioDiario) || '',
                cleanCurrency(p.deducible) || '',
                cleanCurrency(p.prima) || '',
                p.comentarios || '',
            ]);

            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME_CIGNA}A1`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: cignaValues,
                },
            });
            console.log("Datos de cigna guardados exitosamente.")

        }

        // Seccion de pagos
        if (data.metodoPago) {
            let pagoData = [
                clientId,
                `${data.nombre} ${data.apellido}`,
                data.telefono || '',
                data.metodoPago || '',
            ];

            const pagosObservaciones = data.pagoObservaciones || data.observaciones;

            if (data.metodoPago === "banco" && data.pagoBanco) {
                pagoData = pagoData.concat([
                    data.pagoBanco.numCuenta || '',
                    data.pagoBanco.numRuta || '',
                    data.pagoBanco.nombreBanco || '',
                    data.pagoBanco.titularCuenta || '',
                    data.pagoBanco.socialCuenta || '',
                    data.pagoBanco.pagosObservaciones || '',
                ])
            } else if (data.metodoPago === 'tarjeta' && data.pagoTarjeta) {
                pagoData = pagoData.concat([
                    data.pagoTarjeta.numTarjeta || '',
                    data.pagoTarjeta.fechaVencimiento || '',
                    data.pagoTarjeta.titularTarjeta || '',
                    data.pagoTarjeta.cvc || '',
                    '',
                    pagosObservaciones || '',
                ])
            }
            await sheets.spreadsheet.value.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME_PAGOS}!A1`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resources: {
                    values: [pagoData],
                },
            });
            console.log("Datos de pago guardados exitosamente")
        }

        res.status(200).json({
            message: 'Datos del formulario enviados exitosamente',
            clientId: clientId,
            folderName: `${data.nombre} ${data.apellidos} ${data.telefono}`.trim()
        });

    } catch (error) {
        console.error('Error al enviar el formulario:', error.errors || error.message || error);
        res.status(500).json({ error: 'Error interno al enviar el formulario a sheets'});
    }
})
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
