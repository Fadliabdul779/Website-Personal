function terbilang(n) {
  n = Math.floor(Math.abs(n));
  const angka = ['','satu','dua','tiga','empat','lima','enam','tujuh','delapan','sembilan','sepuluh','sebelas'];
  function inWords(x) {
    if (x < 12) return angka[x];
    if (x < 20) return inWords(x - 10) + ' belas';
    if (x < 100) return inWords(Math.floor(x / 10)) + ' puluh' + (x % 10 ? ' ' + inWords(x % 10) : '');
    if (x < 200) return 'seratus' + (x - 100 ? ' ' + inWords(x - 100) : '');
    if (x < 1000) return inWords(Math.floor(x / 100)) + ' ratus' + (x % 100 ? ' ' + inWords(x % 100) : '');
    if (x < 2000) return 'seribu' + (x - 1000 ? ' ' + inWords(x - 1000) : '');
    if (x < 1000000) return inWords(Math.floor(x / 1000)) + ' ribu' + (x % 1000 ? ' ' + inWords(x % 1000) : '');
    if (x < 1000000000) return inWords(Math.floor(x / 1000000)) + ' juta' + (x % 1000000 ? ' ' + inWords(x % 1000000) : '');
    if (x < 1000000000000) return inWords(Math.floor(x / 1000000000)) + ' miliar' + (x % 1000000000 ? ' ' + inWords(x % 1000000000) : '');
    return inWords(Math.floor(x / 1000000000000)) + ' triliun' + (x % 1000000000000 ? ' ' + inWords(x % 1000000000000) : '');
  }
  return (n === 0 ? 'nol' : inWords(n)).trim() + ' rupiah';
}

module.exports = { terbilang };