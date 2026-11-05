# Mis finanzas · Cuentas, importadores y presupuesto

Aplicación web local para registrar cuentas y saldos iniciales, en español y en euros.

## Abrir en Windows

Necesitas Node.js 24 LTS (24.13 o posterior). Haz doble clic en **Abrir Mis Finanzas.cmd**.
El primer inicio instala dependencias y requiere internet; después la aplicación funciona sin conexión.
Se abre en `http://127.0.0.1:4310`. Mantén la ventana de la aplicación abierta mientras la utilizas; ciérrala con Ctrl+C al terminar.

## Incluido

- Alta y edición de cuentas: ING, Openbank, Sabadell, MyInvestor, otro banco y efectivo.
- Tipos: corriente, ahorro, depósito bancario, efectivo de inversión y efectivo.
- Depósitos: importe del capital, interés anual (%), fecha de inicio y vencimiento. Se pueden editar, archivar y filtrar desde Cuentas; su capital se incluye en Ahorro y en el saldo total, sin sumar intereses futuros ni liquidar automáticamente al vencer. Registra también la salida en la cuenta de origen si ya figura en la aplicación para evitar duplicar el dinero. Los depósitos no admiten importación de extractos.
- Nombre, titular opcional y cuatro últimos dígitos opcionales.
- Saldo inicial positivo, cero o negativo y fecha de referencia por cuenta.
- Totales de cuentas activas, búsqueda y filtros.
- Archivar y reactivar cuentas sin borrar su historial.
- Saldo inicial como asiento de apertura, importes en céntimos enteros e historial de cambios.
- Validación en el servidor y detección de ediciones desactualizadas en otras pestañas.
- Importación de ING (XLS), Openbank (HTML con extensión XLS), Sabadell (XLS) y MyInvestor (CSV UTF-8), comprobada con los cuatro extractos facilitados. También admite XLSX y CSV con mapeo de columnas.
- Primera carga: selección de cuenta o alta desde el extracto, elección del día inicial y confirmación del saldo al comenzar ese día. Se incluyen los movimientos de ese día y posteriores.
- ING, Openbank y Sabadell: apertura calculada desde el primer movimiento y conciliación con los saldos del archivo. MyInvestor: saldo inicial manual porque el CSV facilitado no contiene saldos.
- Detección de movimientos ya registrados por cuenta, independiente del nombre de archivo. Los extractos solapados solo añaden los movimientos nuevos. Un mismo importe y concepto en el mismo día se conserva por separado si los saldos posteriores son distintos.
- Movimientos con filtros por cuenta, mes, concepto y entradas/salidas. Se conservan las categorías bancarias, comentarios, fecha valor y archivo original.

Empieza con el saldo que tenía cada cuenta en la fecha elegida. No introduzcas ingresos futuros ni el valor de fondos y acciones como efectivo de MyInvestor. Los importes del formulario se escriben sin separador de miles, por ejemplo `1250,50` o `-35,20`.

El saldo registrado suma la apertura y todos los movimientos importados desde el inicio. Sabadell y Openbank se agrupan por fecha operativa; la fecha valor se conserva por separado. En ING el extracto facilitado solo tiene fecha valor, por lo que se usa esa fecha. Los totales de cuentas son los últimos saldos registrados, no una conciliación de todas las cuentas a una misma fecha.

La importación no guarda datos hasta la confirmación. Si la conciliación falla se bloquea la carga de movimientos nuevos. Las vistas previas caducan a los 30 minutos y al reiniciar el servidor. Al confirmar se guardan de forma atómica el archivo original, su huella, los movimientos y la nueva apertura, si corresponde.

Los archivos no incluyen un identificador bancario único por operación. La deduplicación usa fecha operativa, concepto normalizado, importe, saldo posterior (si existe) y el número de repeticiones de esa combinación. En archivos sin saldo, como MyInvestor, dos cargos verdaderamente iguales del mismo día que aparecen separados en distintas exportaciones pueden ser indistinguibles. La vista previa muestra las coincidencias y esta limitación; conviene exportar el día completo en los periodos que se solapan. No se promete identificación inequívoca de esos casos sin un ID bancario.

La pantalla de movimientos muestra entradas y salidas bancarias. En Presupuesto se asigna cada movimiento a una partida o se excluye como traspaso interno; no se enlazan automáticamente los dos lados de una transferencia. No se categoriza automáticamente sin confirmación del usuario.

## Presupuesto

La vista principal **Cómo voy por partida** muestra el presupuesto, el real asignado, lo que queda y una barra de progreso por partida. El cierre superior separa el dinero previsto que aún no tiene destino del importe que queda por ejecutar; son dos conceptos distintos. Los excesos aparecen con el restante negativo y un aviso. Puedes filtrar por grupo, buscar partidas o mostrar solo partidas pendientes, excedidas o completadas. Los ingresos y remanentes se despliegan con su propio botón.

**Tabla anual** conserva la matriz por meses y las vistas del plan, real, pendiente y original. **Gráficos** incluye la comparación mensual de recursos, presupuesto y ejecución; el reparto del plan por grupos; y la comparación entre plan y real de los grupos principales. Pulsa un mes o un grupo para abrir sus partidas. Las preferencias de año, periodo y vista se recuerdan en ese navegador.

Desde el presupuesto de una partida puedes editar sus meses. Desde su importe real puedes consultar los movimientos asignados. El margen de un mes se distingue del cierre anual: un mes puede aportar remanente para financiar otro aunque el año cierre a cero. Los gráficos del real solo contienen movimientos clasificados y avisan si hay movimientos pendientes de asignar.

La primera ejecución de esta versión carga, una sola vez, noviembre y diciembre de 2026 y todos los meses de 2027. Los 14 totales de gastos y reservas se contrastan con las capturas: 4.850 € y 9.670 € para 2026; 5.004, 6.049, 5.227, 5.892, 4.854, 6.651, 5.584, 5.797, 6.949, 5.302, 4.745 y 8.878 € para 2027. Las ejecuciones posteriores conservan los cambios del usuario.

- Ingreso Jordi: 4.600 €/mes en 2027; ingreso MJ: 1.186 €/mes. En 2026 se respetan las entradas de la captura: principal de 0 € en noviembre y 4.369 € en diciembre, más devolución del préstamo a la madre de 464 € en cada mes.
- Los 366 € de «Paro MJ» pasan a reparaciones del coche en diciembre de 2026, sin duplicar la partida.
- Los 2.079 € de Abril son saldo acumulado reservado para ella, fuera del dinero disponible para gastos familiares.
- Los 1.500 € reservados en diciembre de 2026 para el siguiente presupuesto se muestran como remanente de enero de 2027. No crean un segundo ingreso real.
- Los saldos bancarios y «Cuenta Piso» no son ingresos ni gastos del presupuesto.
- Las filas de teléfono, suscripciones y gasolina de 2026 se recuperan de la primera captura, fuera del recorte posterior. Con ellas cuadran ambos totales mensuales.

Se puede consultar el plan actual, el real clasificado, la diferencia pendiente y el original de las capturas. Pulsa un importe para modificarlo, opcionalmente en todos los meses cargados del año. Los importes originales no se sobrescriben y los ajustes se guardan en el historial. Las partidas pueden añadirse y renombrarse; el tipo no se puede cambiar si ya tienen movimientos asignados.

Cada movimiento se asigna por su fecha operativa/contable usada en la importación. Una devolución asignada a una partida de gasto reduce su real. Los movimientos sin asignar no se incorporan al real y su número se muestra expresamente. Excluye ambos lados de los traspasos internos; no vuelvas a clasificar una liquidación de tarjeta como gasto si también has importado sus compras. Las reservas y aportaciones a inversiones se muestran separadas del consumo.

Si hay movimientos en un mes sin captura presupuestaria, el mes aparece con previsiones vacías. Una diferencia negativa muestra la financiación que falta; el sistema no crea ingresos o saldos iniciales ficticios para cerrar el presupuesto a cero. La diferencia pendiente no equivale a pagos pendientes si aún quedan movimientos por importar o clasificar. Los remanentes son financiación prevista, no movimientos reales.

## Cierre mensual y saldos acumulados

En Presupuesto, selecciona un mes y pulsa **Revisar cierre de mes**. La vista previa muestra el objetivo, el saldo anterior, el real, el sobrante o déficit y el disponible del mes siguiente para todas las partidas de gastos y ahorro. Solo se puede cerrar un mes terminado, sin movimientos pendientes de asignar y con los meses anteriores cerrados. Confirma también que has importado todos los extractos.

Disponible = objetivo del mes + saldo anterior − real asignado. El sobrante o déficit se arrastra conservando su signo. Los objetivos y las capturas originales no se sobrescriben. El cierre crea el mes siguiente si hace falta, también al cambiar de año. No crea movimientos bancarios ni ingresos reales, y los totales de varios meses cuentan una sola vez los arrastres entre ellos.

El mes cerrado no admite cambios de objetivos, asignaciones ni nuevas importaciones. Pulsa **Mes cerrado · Deshacer cierre** para corregirlo y volver a cerrarlo. Si el siguiente mes ya está cerrado, reabre primero el más reciente. Los cierres, reaperturas y saldos iniciales quedan en el historial.

Los 2.079 € de Abril se reinterpretan una sola vez como saldo inicial acumulado desde noviembre de 2026, con objetivo nuevo de 0 €, conservando el original. Esta corrección automática solo se aplica si la previsión original sigue sin editar. Al editar el presupuesto de una partida puedes consultar o establecer su saldo previo al seguimiento; si ya procede de un cierre debes reabrir ese cierre para corregirlo. Un saldo inicial ya conocido en el mes siguiente no se suma a otro arrastre distinto sin revisarlo, para evitar duplicaciones. Al cerrar diciembre de 2026, el remanente original de 1.500 € previsto para enero, si no se ha editado, se sustituye por los arrastres calculados; al deshacer se restaura su efecto.

## Datos locales y OneDrive

La base de datos real se crea en `%LOCALAPPDATA%\PersonalFinances\finances.sqlite`, fuera de OneDrive. Incluye los extractos originales confirmados. No se almacena en el navegador ni se suben datos a un servicio. El código del proyecto puede estar en OneDrive.

**La sincronización de datos entre PC y la recuperación de versiones todavía no están implementadas**: pertenecen al punto 6. Cada PC tendrá sus propios datos hasta completar esa fase. No copies ni sincronices la base de datos mientras la aplicación esté abierta; SQLite puede tener archivos auxiliares WAL con cambios pendientes. No utilices `FINANCE_DATA_DIR` para situar la base de datos activa en OneDrive.

Los datos no están cifrados por la aplicación; quedan protegidos por los permisos de tu usuario de Windows. El servicio solo escucha en `127.0.0.1`, sin acceso desde otros ordenadores. No se guardan credenciales bancarias. El historial es interno para futuras funciones; aún no hay pantalla de auditoría.

## Desarrollo

```powershell
npm ci
npm run dev
```

Interfaz de desarrollo: `http://127.0.0.1:5173`; API: `http://127.0.0.1:4310`.

```powershell
npm test
npm run build
npm start
```

React + TypeScript + Vite, Fastify y SQLite mediante el módulo `node:sqlite` de Node.js. Este módulo puede emitir un aviso de función experimental en Node 24. La versión de las dependencias queda fijada en `package-lock.json`.

Para pruebas o un perfil separado, configura `FINANCE_DATA_DIR` con un directorio local fuera de OneDrive antes de iniciar el servidor. Las pruebas automatizadas crean sus propios directorios temporales y no modifican tus cuentas.
