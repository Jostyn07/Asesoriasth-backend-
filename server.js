// === 1. IMPORTS Y CONFIGURACIÓN ===
import dotenv from 'dotenv';
dotenv.config();

import { Readable } from 'stream'; 
import express from 'express';
import { google } from 'googleapis';
import multer from 'multer';
import cors from 'cors'; 
import bcrypt from 'bcrypt'; 
import { query } from './db.js';

// === 2. CONSTANTES ===
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME_OBAMACARE = "Pólizas";
const SHEET_NAME_CIGNA = "Cigna Complementario";
const SHEET_NAME_PAGOS = "Pagos";
const SHEET_NAME_DRAFTS = "Borrador";
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// === 3. HELPERS ===

async function getAuthenticatedClient() {
    // Intentar obtener credenciales de diferentes variables de entorno
    const credentialsRaw = process.env.GOOGLE_CREDENTIALS || 
                           process.env.GOOGLE_APPLICATION_CREDENTIALS || 
                           process.env.GOOGLE_SA_CREDENTIALS;
    
    if (!credentialsRaw) {
        throw new Error('No se encontraron credenciales de Google. Configura GOOGLE_CREDENTIALS en Render.');
    }
    
    let credentials;
    try {
        credentials = JSON.parse(credentialsRaw);
    } catch (parseError) {
        console.error('❌ Error parseando credenciales JSON:', parseError.message);
        console.error('Primeros 50 caracteres:', credentialsRaw.substring(0, 50));
        throw new Error(`Credenciales JSON inválidas: ${parseError.message}`);
    }
    
    const authClient = new google.auth.GoogleAuth({
        credentials,
        scopes: [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets'
        ]
    });
    return await authClient.getClient();
}

function cleanCurrency(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/[$,]/g, '').trim(); 
}

// === 4. CONFIGURACIÓN DE EXPRESS ===
const app = express();
const upload = multer();

const allowedOrigins = [
    "https://asesoriasth.com", 
    "http://127.0.0.1:5500", 
    "https://asesoriasth.com/formulario.html", 
    "https://jostyn07.github.io",
    "https://jostyn07.github.io/Asesoriasth-",
    "https://asesoriasth-backend-der.onrender.com"
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`No autorizado por CORS. Origen: ${origin}`));
        }
    },
    credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

// === 5. ENDPOINT DE LOGIN ===
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`Intento de login para: ${email}`);

    if (!email || !password) {
        return res.status(400).json({ error: 'Faltan credenciales (correo y contraseña).' });
    }

    try {
        const sql = 'SELECT id, nombre, email, password, rol FROM users WHERE email = $1';
        const values = [email];
        const users = await query(sql, values);

        if (users.length === 1) {
            const user = users[0];
            const match = await bcrypt.compare(password, user.password);
            
            if (match) {
                console.log(`✅ Usuario autenticado: ${user.nombre}`);
                const token = `local_auth_token_${user.id}`; 

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
                console.error(`❌ Contraseña incorrecta para ${email}`);
                return res.status(401).json({ error: 'Credenciales inválidas'});  
            }
        } else {
            console.error(`❌ Usuario no encontrado: ${email}`);
            return res.status(401).json({ error: 'Credenciales inválidas'});  
        }
    } catch (error) {
        console.error('❌ Error en la consulta de login:', error);
        return res.status(500).json({ error: 'Error interno del servidor al intentar iniciar sesión' });
    }
});

// === 6. ENDPOINT DE UPLOAD DE ARCHIVOS ===
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

// === 7. ENDPOINT PARA CREAR CARPETA ===
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
      supportsAllDrives: true 
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

// === 8. ENDPOINT PARA GUARDAR BORRADOR (MULTI-USUARIO) ===
// MODIFICADO: Siempre crea un NUEVO borrador, no actualiza existentes
app.post('/api/save-draft', async (req, res) => {
    try {
        const data = req.body;
        console.log('📝 Guardando NUEVO borrador en Google Sheets (Multi-Usuario)...');

        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        // El draftId ya viene del frontend (basado en nombre+teléfono+timestamp)
        const draftId = data.draftId;
        const timestamp = new Date().toLocaleString('es-ES', { 
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        // Construir la fila de borrador
        const draftRow = [
            data.operador || data.operadorBorrador || '',
            data.fechaRegistro || '',
            data.tipoVenta || '',
            data.claveSeguridad || '',
            'Titular',
            data.nombre || '',
            data.apellidos || '',
            data.sexo || '',
            data.correo || '',
            data.telefono || '',
            data.telefono2 || '',
            data.fechaNacimiento || '',
            data.estadoMigratorio || '',
            data.ssn || '',
            cleanCurrency(data.ingresos) || '',
            data.ocupación || '',
            data.nacionalidad || '',
            data.aplica || '',
            data.cantidadDependientes || '0',
            data.poBox ? `PO Box: ${data.poBox}` :
                `${data.direccion || ''}, ${data.casaApartamento || ''}, ${data.condado || ''}, ${data.ciudad || ''}, ${data.estado || ''}, ${data.codigoPostal || ''}`.replace(/,\s*,/g, ', ').replace(/,\s*$/, '').trim(),            
            data.compania || '',
            data.plan || '',
            cleanCurrency(data.creditoFiscal) || '',
            cleanCurrency(data.prima) || '',
            data.link || '',
            data.observaciones || '',
            draftId,
            timestamp,
            JSON.stringify(data, null, 2)
        ];

        // SIEMPRE INSERTAR como nueva fila (no buscar ni actualizar)
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_DRAFTS}!A1`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [draftRow],
            },
        });
        
        console.log(`✅ Nuevo borrador creado: ${draftId}`);

        res.status(200).json({
            message: 'Borrador guardado exitosamente en Google Sheets',
            draftId: draftId,
            timestamp: timestamp
        });

    } catch (error) {
        console.error('❌ Error al guardar borrador:', error.errors || error.message || error);
        res.status(500).json({ 
            error: 'Error interno al guardar borrador en Sheets',
            details: error.message 
        });
    }
});

// === 9. NUEVO ENDPOINT PARA LISTAR TODOS LOS BORRADORES ===
app.get('/api/list-drafts', async (req, res) => {
    try {
        console.log('📋 Listando todos los borradores...');

        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        // Obtener todos los borradores
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_DRAFTS}!A:AD`,
        });

        const rows = response.data.values || [];
        
        if (rows.length <= 1) {
            return res.status(200).json({
                message: 'No hay borradores guardados',
                drafts: []
            });
        }

        // Parsear los borradores (saltar la primera fila de encabezados)
        const drafts = [];
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            
            try {
                drafts.push({
                    operador: row[0] || '',
                    fechaRegistro: row[1] || '',
                    nombre: row[5] || '',
                    apellidos: row[6] || '',
                    telefono: row[9] || '',
                    correo: row[8] || '',
                    draftId: row[26] || '',
                    timestamp: row[27] || '',
                    operadorBorrador: row[0] || '',
                    jsonData: row[28] || '' // Para referencia, aunque no se envía completo
                });
            } catch (parseError) {
                console.warn(`⚠️ Error parseando fila ${i}:`, parseError);
            }
        }

        // Ordenar por timestamp más reciente primero
        drafts.sort((a, b) => {
            const dateA = new Date(a.timestamp || 0);
            const dateB = new Date(b.timestamp || 0);
            return dateB - dateA;
        });

        console.log(`✅ ${drafts.length} borradores encontrados`);

        res.status(200).json({
            message: 'Borradores listados exitosamente',
            drafts: drafts,
            total: drafts.length
        });

    } catch (error) {
        console.error('❌ Error al listar borradores:', error);
        res.status(500).json({ 
            error: 'Error interno al listar borradores',
            details: error.message 
        });
    }
});

// === 10. ENDPOINT PARA CARGAR BORRADOR DESDE SHEETS ===
app.get('/api/load-draft/:draftId', async (req, res) => {
    try {
        const { draftId } = req.params;
        console.log(`📂 Cargando borrador ${draftId} desde Google Sheets...`);

        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_DRAFTS}!A:AD`,
        });

        const rows = response.data.values || [];
        
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][26] === draftId) {
                const jsonData = rows[i][28];
                
                if (jsonData) {
                    const draftData = JSON.parse(jsonData);
                    return res.status(200).json({
                        message: 'Borrador cargado exitosamente',
                        data: draftData
                    });
                }
            }
        }

        res.status(404).json({ error: 'Borrador no encontrado' });

    } catch (error) {
        console.error('❌ Error al cargar borrador:', error);
        res.status(500).json({ 
            error: 'Error interno al cargar borrador desde Sheets',
            details: error.message 
        });
    }
});

// === 11. ENDPOINT PARA ELIMINAR BORRADOR DE SHEETS ===
app.delete('/api/delete-draft/:draftId', async (req, res) => {
    try {
        const { draftId } = req.params;
        console.log(`🗑️ Eliminando borrador ${draftId} de Google Sheets...`);

        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_DRAFTS}!A:AD`,
        });

        const rows = response.data.values || [];
        
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][26] === draftId) {
                // IMPORTANTE: Ajusta el sheetId según tu hoja "Borrador"
                // Para obtenerlo, mira la URL: ...#gid=XXXXXX
                const SHEET_ID_BORRADOR = 0; // ⚠️ CAMBIAR por el ID real de tu hoja "Borrador"
                
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    resource: {
                        requests: [{
                            deleteDimension: {
                                range: {
                                    sheetId: SHEET_ID_BORRADOR,
                                    dimension: 'ROWS',
                                    startIndex: i,
                                    endIndex: i + 1
                                }
                            }
                        }]
                    }
                });

                return res.status(200).json({
                    message: 'Borrador eliminado exitosamente'
                });
            }
        }

        res.status(404).json({ error: 'Borrador no encontrado' });

    } catch (error) {
        console.error('❌ Error al eliminar borrador:', error);
        res.status(500).json({ 
            error: 'Error interno al eliminar borrador de Sheets',
            details: error.message 
        });
    }
});

// === 12. ENDPOINT DE SUBMIT FORM DATA ===
app.post('/api/submit-form-data', async (req, res) => {
    try {
        const data = req.body;

        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        const clientId = `CLI-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
        const fechaRegistroUS = data.fechaRegistro || '';

        const obamacareData = [
            data.operador || '',
            fechaRegistroUS,
            data.tipoVenta || '',
            data.claveSeguridad || '',
            'Titular',
            data.nombre || '',
            data.apellidos || '',
            data.sexo || '',
            data.correo || '',
            data.telefono || '',
            data.telefono2 || '',
            data.fechaNacimiento || '',
            data.estadoMigratorio || '',
            data.ssn || '',
            cleanCurrency(data.ingresos) || '',
            data.ocupación || '',
            data.nacionalidad || '',
            data.aplica || '',
            data.cantidadDependientes || '0',
            data.poBox ? `PO Box: ${data.poBox}` :
                `${data.direccion || ''}, ${data.casaApartamento || ''}, ${data.condado || ''}, ${data.ciudad || ''}, ${data.estado || ''}, ${data.codigoPostal || ''}`.replace(/,\s*,/g, ', ').replace(/,\s*$/, '').trim(),            
            data.compania || '',
            data.plan || '',
            cleanCurrency(data.creditoFiscal) || '',
            cleanCurrency(data.prima) || '',
            data.link || '',
            data.observaciones || '',
            clientId,          
        ];
        
        let obamacareRows = [obamacareData];

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
                '', '', '', '',
                dep.fechaNacimiento || '',
                dep.estadoMigratorio || '',
                dep.ssn || '', 
                '', '', '', dep.aplica || '',
                '', '', '', '', '', '', '', '',
                clientId
            ]);
        });
        }

        const obamacareSheetResponse = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_OBAMACARE}!A1`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: obamacareRows,
            },
        });
        console.log(`Datos de Obamacare guardados en Sheets`);
        
        if (data.cignaPlans &&  data.cignaPlans.length > 0) {
            const cignaValues = data.cignaPlans.map((p) => [
                clientId,
                new Date().toLocaleDateString('es-ES'),
                `${data.nombre} ${data.apellidos}`,
                data.telefono || '',
                data.sexo || '',
                p.fechaNacimiento || '',
                data.poBox ? `PO Box: ${data.poBox}` :
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
                range: `${SHEET_NAME_CIGNA}!A1`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: cignaValues,
                },
            });
            console.log("Datos de cigna guardados exitosamente.")
        }

        if (data.metodoPago) {
            let pagoData = [
                clientId,
                `${data.nombre} ${data.apellidos}`,
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
                    pagosObservaciones || '',
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
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME_PAGOS}!A1`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: [pagoData],
                },
            });
            console.log("Datos de pago guardados exitosamente")
        }

        // ❌ ELIMINADO: Ya no borramos el borrador al enviar
        // El usuario quiere mantener los borradores en Sheets
        console.log('ℹ️ Borrador NO eliminado (comportamiento configurado)');

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

// === 13. INICIO DEL SERVIDOR ===
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log(`Modo: Multi-Usuario (correo compartido)`);
});
