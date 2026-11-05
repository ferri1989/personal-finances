export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } }); }
  catch { throw new Error('No se puede conectar con la aplicación local. Comprueba que está arrancada.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('El servidor ha devuelto una respuesta inesperada. Recarga la página.'); }
  if (!response.ok) throw new Error(body.message || 'No se ha podido completar la operación.');
  return body;
}
