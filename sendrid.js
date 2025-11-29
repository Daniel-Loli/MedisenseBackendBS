const sgMail = require('@sendgrid/mail');
require("dotenv").config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
console.log('Clave de API de SendGrid:', process.env.SENDGRID_API_KEY);
const msg = {
  to: 'nilton.loli@unmsm.edu.pe',
  from: 'camila.cuba@unmsm.edu.pe', // <-- tu Gmail verificado
  subject: 'Código de verificación - MediSense AI',
  text: 'Tu código de verificación es 123456',
  html: '<h1>Tu código de verificación es <b>123456</b></h1>',
};

sgMail
  .send(msg)
  .then(() => console.log('Email enviado correctamente!'))
  .catch((error) => console.error('Error:', error));
