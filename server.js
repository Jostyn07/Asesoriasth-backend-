// server.js (VERSION CORREGIDA para ES Modules y Render)

// === 1. IMPORTS Y CONFIGURACIÓN ===
// Usamos 'import' para todo ya que 'type': 'module' está en package.json
import dotenv from 'dotenv';
dotenv.config();

import { Readable } from 'stream'; 
import express from 'express';
import { google } from 'googleapis';
import multer from 'multer';
import cors from 'cors'; 
import bcrypt from 'bcrypt'; 
// Importamos la función de query para PostgreSQL
import { query } from './db.js';

// === 2. CONSTANTES ===
const SPREADSHEET_ID = "1T8YifEIUU7a6ugf_Xn5_1edUUMoYfM9loDuOQU1u2-8";
const SHEET_NAME_OBAMACARE = "Pólizas";
const SHEET_NAME_CIGNA = "Cigna Complementario";
const SHEET_NAME_PAGOS = "Pagos";
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID; // Se lee del entorno

// === 3. HELPERS ===

/**
 * Obtiene un cliente autenticado usando las credenciales de Service Account 
 * almacenadas en la variable de entorno GOOGLE_SA_CREDENTIALS de Render.
 */
async function getAuthenticatedClient() {
    // CRÍTICO: Asegurarse de que esta variable de entorno contenga el JSON completo
    const credentials = JSON.parse(process.env.GOOGLE_SA_CREDENTIALS);

    const authClient = new google.auth.GoogleAuth ({ // CORREGIDO: .aut a .auth
        credentials, // Usamos las credenciales JSON del entorno
        scopes: [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets'
        ]
    });
    return await authClient.getClient();
}

// Helper para limpiar formato de moneda
function cleanCurrency(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/[$,]/g, '').trim(); 
}

// === 4. CONFIGURACIÓN DE EXPRESS ===
const app = express();
const upload = multer();

// CRÍTICO: CORS actualizado para permitir solicitudes desde el Frontend
const allowedOrigins = [
    "https://asesoriasth.com", 
    "http://127.0.0.1:5500", 
    "https://asesoriasth.com/formulario.html", 
    "https://jostyn07.github.io", // Raíz de tu GitHub Pages
    "https://jostyn07.github.io/Asesoriasth-", // Ruta del proyecto en GitHub Pages
    "https://asesoriasth-backend-der.onrender.com" // Tu propio dominio de Render
];
const corsOptions = {
    origin: function (origin, callback) {
        // Permitir peticiones sin 'Origin' (como peticiones de servidor a servidor)
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
app.post('/api/login', async (req, res) => { // CORREGIDO: async.post a app.post
    const { email, password } = req.body;
    console.log(`Intento de login para: ${email}`);

    if (!email || !password) {
        return res.status(400).json({ error: 'Faltan credenciales (correo y contraseña).' });
    }

    try {
        // 1. Buscar usuario por email
        const sql = 'SELECT id, nombre, email, password FROM users WHERE email = $1';
        const values = [email];
        // CORREGIDO: Se usa `query` para obtener `users`
        const users = await query(sql, values);

        if (users.length === 1) {
            const user = users[0];
            
            // 2. Comparar la contraseña con el hash guardado (BCRYPT)
            const match = await bcrypt.compare(password, user.password); // Asumimos que bcrypt está instalado
            
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
// La lógica aquí parece correcta, asumiendo que el Service Account tiene permisos
app.post('/api/upload-files', upload.array('files'), async (req, res) => {
    // ... (El código de upload.array('files') parece mayormente correcto, se mantiene)
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
  // ... (El código de create-folder es correcto, se mantiene)
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


// === 8. ENDPOINT DE SUBMIT FORM DATA (GOOGLE SHEETS) ===
app.post('/api/submit-form-data', async (req, res) => {
    try {
        const data = req.body;

        const authClient = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });

        const clientId = `CLI-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}` // CORREGIDO: slice.slice a slice
        const fechaRegistroUS = data.fechaRegistro || ''; // CORREGIDO: fechaRegisto a fechaRegistro

        // Preparar y enviar datos de Obamacare y dependientes
        const obamacareData = [
            data.operador || '',
            fechaRegistroUS,
            data.tipoVenta || '',
            data.claveSeguridad || '', // CORREGIDO: claveSeguidad a claveSeguridad
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
            data.observaciones || '' , // CORREGIDO: observacion a observaciones
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
        const obamacareSheetResponse = await sheets.spreadsheets.values.append({ // CORREGIDO: spreadsheet a spreadsheets
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME_OBAMACARE}!A1`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS', // CORREGIDO: insetDataOption a insertDataOption
            resource: {
                values: obamacareRows,
            },
        });
        console.log(`Datos de Obamacare y dependientes guardados en Sheets, fila(s) ${obamacareSheetResponse.data.updates.updatedRange}`); // CORREGIDO: updateRange a updatedRange
        
        // Preparar y enviar datos de cigna
        if (data.cignaPlans &&  data.cignaPlans.length > 0) {
            const cignaValues = data.cignaPlans.map((p) => [
                clientId,
                new Date().toLocaleDateString('es-ES'), // CORREGIDO: newDate a new Date()
                `${data.nombre} ${data.apellidos}`, // CORREGIDO: apellido a apellidos
                data.telefono || '',
                data.sexo || '',
                p.fechaNacimiento || '',
                data.poBox ? `PO Box: ${data.poBox}` : // CORREGIDO: p.data.poBox a data.poBox
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
                range: `${SHEET_NAME_CIGNA}!A1`, // CORREGIDO: faltaba el '!'
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
                `${data.nombre} ${data.apellidos}`, // CORREGIDO: apellido a apellidos
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
                    pagosObservaciones || '', // CORREGIDO: pdata.pagoBanco.pagosObservaciones a pagosObservaciones
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
            await sheets.spreadsheets.values.append({ // CORREGIDO: spreadsheet.value a spreadsheets.values
                spreadsheetId: SPREADSHEET_ID,
                range: `${SHEET_NAME_PAGOS}!A1`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: { // CORREGIDO: resources a resource
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


// === 9. INICIO DEL SERVIDOR ===
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});