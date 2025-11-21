// Este script exporta todos os clientes de uma API paginada do Xano
// e salva o resultado num ficheiro JSON.
// URL do seu endpoint no Xano que busca os clientes.
const XANO_API_URL = 'https://x5ii-4wuf-1p2t.n7c.xano.io/api:mg0JJpwR/buscaClientes';
async function exportAllClients() {
  let allClients = [];
  let currentPage = 1;
  let totalPages = 1; // Será atualizado na primeira chamada
  console.log('Iniciando a exportação dos clientes do Xano...');
  // Faz a primeira chamada para obter o total de páginas
  try {
    const firstResponse = await fetch(`${XANO_API_URL}?page=1`);
    if (!firstResponse.ok) throw new Error(`Erro na API do Xano: ${firstResponse.statusText}`);
    const firstData = await firstResponse.json();
    totalPages = firstData.pageTotal;
    console.log(`Total de páginas a serem buscadas: ${totalPages}`);
    // Adiciona a informação da página a cada cliente
    const clientsWithPage = firstData.items.map((client)=>({
        ...client,
        xano_pagina: 1
      }));
    allClients.push(...clientsWithPage);
    console.log(`... Página 1 processada. ${allClients.length} clientes exportados.`);
    currentPage = 2;
  } catch (error) {
    console.error('Falha ao buscar a primeira página:', error);
    return; // Para a execução se a primeira página falhar
  }
  // Continua a buscar as páginas restantes
  while(currentPage <= totalPages){
    const url = `${XANO_API_URL}?page=${currentPage}`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Erro na API do Xano: ${response.statusText}`);
      const data = await response.json();
      const clientsPage = data.items || [];
      if (clientsPage.length > 0) {
        const clientsWithPage = clientsPage.map((client)=>({
            ...client,
            xano_pagina: currentPage
          }));
        allClients.push(...clientsWithPage);
        console.log(`... Página ${currentPage} processada. Total: ${allClients.length} clientes.`);
      }
      currentPage++;
    } catch (error) {
      console.error(`Falha ao buscar a página ${currentPage}:`, error);
      break;
    }
  }
  // Salva todos os clientes num ficheiro JSON
  await Deno.writeTextFile('clientes_xano.json', JSON.stringify(allClients, null, 2));
  console.log(`✅ Exportação concluída! ${allClients.length} clientes foram salvos em clientes_xano.json`);
}
exportAllClients();
