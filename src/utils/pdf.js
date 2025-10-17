const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const dayjs = require('dayjs');
const { terbilang } = require('./terbilang');

function generatePenarikanPDF({
  outputDir,
  trx_no,
  santri,
  jumlah,
  keterangan,
  kasir,
  penerima,
  ttdPemberiPath,
  ttdPenerimaPath,
  logoPath = null,
  stampPath = null,
}) {
  const doc = new PDFDocument({ margin: 50 });
  const filePath = path.join(outputDir, `${trx_no}.pdf`);
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Branding header
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, 50, 40, { width: 60 }); } catch(e) {}
  }
  doc.fontSize(16).text('BUKTI PENARIKAN TABUNGAN SANTRI', { align: 'center' });
  doc.moveDown();

  doc.fontSize(11);
  doc.text(`Nomor Trx: ${trx_no}`);
  doc.text(`Tanggal: ${dayjs().format('DD MMMM YYYY, HH:mm')}`);
  doc.moveDown(0.5);
  doc.text(`Nama Santri: ${santri.nama}`);
  doc.text(`NIS: ${santri.nis}`);
  doc.text(`Kelas: ${santri.kelas || '-'}`);
  doc.text(`Jumlah: Rp ${formatRupiah(jumlah)} (${capitalize(terbilang(jumlah))})`);
  if (keterangan) doc.text(`Keterangan: ${keterangan}`);
  doc.moveDown();

  // Signatures section
  doc.fontSize(12).text('Pihak Terkait', { align: 'left' });
  doc.moveDown(0.5);

  const startY = doc.y;
  doc.fontSize(11).text(`Pemberi (Kasir): ${kasir}`, 50, startY);
  if (ttdPemberiPath && fs.existsSync(ttdPemberiPath)) {
    doc.image(ttdPemberiPath, 50, startY + 20, { width: 180 });
  } else {
    // Placeholder tanda tangan untuk penandatanganan setelah dicetak
    doc.rect(50, startY + 20, 180, 80).stroke();
    doc.fontSize(8).text('Tanda Tangan Pemberi (Kasir)', 60, startY + 105);
  }

  doc.fontSize(11).text(`Penerima: ${penerima}`, 350, startY);
  if (ttdPenerimaPath && fs.existsSync(ttdPenerimaPath)) {
    doc.image(ttdPenerimaPath, 350, startY + 20, { width: 180 });
  } else {
    doc.rect(350, startY + 20, 180, 80).stroke();
    doc.fontSize(8).text('Tanda Tangan Penerima', 360, startY + 105);
  }

  // Optional stamp
  if (stampPath && fs.existsSync(stampPath)) {
    try { doc.image(stampPath, 260, startY + 120, { width: 80, opacity: 0.6 }); } catch(e) {}
  } else {
    doc.rect(260, startY + 120, 80, 80).stroke();
    doc.fontSize(8).text('Cap/Stempel', 265, startY + 150);
  }

  doc.moveDown(6);
  doc.fontSize(10).text('Catatan: Bukti ini sah sebagai acuan transaksi.', { align: 'center' });
  doc.fontSize(10).text('Tanda tangan dilakukan setelah dokumen dicetak.', { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

function formatRupiah(n) {
  return (n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { generatePenarikanPDF };