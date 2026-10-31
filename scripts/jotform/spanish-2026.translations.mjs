// Spanish text for the Employment Application-ESP 2026 form, keyed by the English form's
// question IDs (the clone keeps them). clone-spanish-form.mjs composes each bilingual label
// as "<English>/ <Spanish>" from the live English text, so the English wording can never drift
// from the English form; only the Spanish half lives here.
//
//   text       Spanish for the question label (plain text) or, for HTML paragraphs
//              (control_text), the Spanish paragraphs appended after the English ones.
//   options    { "English option": "Spanish option" }. The composed value is
//              "English/ Spanish", which is what the import's Spanish rule expects (it keeps the
//              text before the first "/"). An option missing here is left in English on purpose:
//              position titles, brand names (Indeed.com), "GED", "No".
//   values     { "English option": "replacement value" } for an option whose stored value must
//              change rather than gain a translation (the location names, which the import
//              normalises through its alias table).
//   sublabels  { key: "Spanish" } for sub-fields (name parts, date parts, phone).
//   subLabel / hint / emptyText / otherText / nextButtonText / buttonText / clearText
//              Spanish for those strings; composed the same way.
//
// Conditions referring to an option that gains a translation or a new value are rewritten by
// the script from the same table, so "Yes" → "Yes/ Sí" keeps "If yes…" boxes appearing.
//
// Please have a Spanish speaker read the Agreement and Release paragraphs (219–331), the MVR
// authorisation (368) and the drug-test consent (238) before the form is linked from the
// careers page. The wording follows the current Spanish form where the English was unchanged.

export const FORM = {
  title: "Employment Application-ESP 2026",
  pagetitle: "Employment Application-ESP 2026",
  thankurl: "https://rexius.com/pages/solicitud-de-empleo-de-rexius-gracias",
};

const SI_NO = { Yes: "Sí" };
const NEXT = "Siguiente";
const TYPE_HERE = "Escriba aquí...";
const DATE_PARTS = { litemode: "Fecha", month: "Mes", day: "Día", year: "Año" };
const PHONE_PARTS = { masked: "Introduzca un número de teléfono válido." };
const TERM_HEAD = '<p><span style="font-weight: bold; color: #000000;">Término, condición, expectativa y/o acuerdo</span></p>';

export const QUESTIONS = {
  // Page 1: intro
  16: { text: "Solicitud de empleo", nextButtonText: NEXT },
  5: { text: "<p>Rexius es un empleador que ofrece igualdad de oportunidades. Complete este formulario de manera completa, honesta y precisa. Agradecemos su interés en trabajar con Rexius.</p>" },

  // Job interest
  41: { text: "Interés laboral", nextButtonText: NEXT },
  342: {
    text: "¿A qué ubicación está solicitando?",
    emptyText: "Seleccione",
    // "Eugene/Springfield" would lose its second half to the Spanish import rule (text before
    // the first "/"); "Eugene-Springfield" is in the import's location alias table.
    values: { "Eugene/Springfield": "Eugene-Springfield" },
  },
  343: { text: "¿Qué puesto está solicitando en Lake Oswego?", emptyText: "Seleccione" },
  340: { text: "¿Qué puesto está solicitando en Eugene/Springfield?", emptyText: "Seleccione" },
  341: { text: "¿Qué puesto está solicitando en Central Oregon?", emptyText: "Seleccione" },
  268: {
    text: "¿Cómo se enteró de este puesto de trabajo?",
    options: { "I am a Previous Employee": "Soy ex empleado", "Walk In": "Me presenté en persona", Other: "Otro" },
    otherText: "Referencia",
  },
  355: { text: "¿Quién lo refirió?", subLabel: "Debe ser un empleado actual." },
  384: { text: "¿Cómo se enteró del puesto?" },
  272: { text: "¿Ha trabajado antes para Rexius o sus afiliados?", options: SI_NO },
  273: { text: "En caso afirmativo, indique las fechas de empleo, la ubicación y el puesto.", hint: TYPE_HERE },
  274: { text: "¿Ha solicitado antes trabajo con Rexius o sus afiliados?", options: SI_NO },
  275: { text: "En caso afirmativo, indique la fecha, la ubicación y el puesto que solicitó.", hint: TYPE_HERE },

  // Personal information
  262: { text: "Información personal", nextButtonText: NEXT },
  261: { text: "Fecha disponible para empezar", sublabels: DATE_PARTS },
  9: { text: "Nombre", sublabels: { first: "Nombre", middle: "Segundo nombre", last: "Apellido" } },
  263: {
    text: "Dirección",
    sublabels: { addr_line1: "Dirección", addr_line2: "Dirección, línea 2", city: "Ciudad", state: "Estado", postal: "Código postal" },
  },
  264: { text: "Número de teléfono", sublabels: PHONE_PARTS },
  266: { text: "Tipo de teléfono", options: { Home: "Casa", Cell: "Celular" } },
  265: { text: "Número de teléfono alternativo", sublabels: PHONE_PARTS },
  267: { text: "Tipo de teléfono", options: { Home: "Casa", Cell: "Celular" } },
  22: { text: "Correo electrónico", subLabel: "ejemplo@ejemplo.com" },
  21: { text: "Método de contacto preferido", options: { Phone: "Teléfono", Email: "Correo electrónico" } },
  311: { text: "¿Tiene al menos 18 años de edad?", options: SI_NO },
  312: { text: "¿Puede, al ser contratado, presentar identificación adecuada que documente y verifique su identidad y su derecho legal a trabajar en los EE. UU.?", options: SI_NO },
  386: { text: "¿Tiene experiencia con montacargas?", options: SI_NO },
  395: { text: "¿Tiene una licencia vigente de aplicador de herbicidas, o una licencia vigente de aprendiz de aplicador de herbicidas?", options: SI_NO, emptyText: "Seleccione" },
  370: { text: "<p>Seleccionó un puesto que requiere conducir un vehículo de la empresa. Complete la siguiente información.</p>" },
  30: { text: "Número de licencia de conducir" },
  31: { text: "Fecha de vencimiento", sublabels: DATE_PARTS },
  35: { text: "Clase o tipo de licencia" },
  368: {
    text: "<p>Yo, el abajo firmante, autorizo a Rexius Forest By-Products, Inc. a obtener un informe del Registro de Vehículos Motorizados (MVR). Entiendo que este informe puede incluir información sobre mi historial de manejo, que incluye, entre otros, citaciones de tránsito, accidentes, infracciones de manejo y otros datos relacionados. Reconozco que Rexius puede basarse en este informe para tomar decisiones sobre mi solicitud, mi empleo u otras consideraciones relacionadas.</p>\n<p>Entiendo que tengo derechos bajo la Ley de Informes de Crédito Justos (FCRA), incluido el derecho a saber si se ha tomado una medida adversa basada en la información del informe MVR, y el derecho a verificar la exactitud e integridad de cualquier información proporcionada por la agencia de informes del consumidor.</p>\n<p>Reconozco que esta autorización permanecerá vigente hasta que la revoque por escrito, y acepto que una copia de esta autorización tiene la misma validez que el original.</p>\n<p>Al firmar a continuación, afirmo que comprendo y acepto los términos anteriores.</p>",
  },
  369: { text: "Firma" },
  66: { text: "Enumere las licencias especiales de vehículos motorizados u operador, o certificaciones de oficio, que tenga vigentes.", hint: TYPE_HERE },

  // Education
  57: { text: "Educación y capacitación", nextButtonText: NEXT },
  344: {
    text: "Marque su nivel más alto de educación:",
    options: {
      None: "Ninguno", "High School Diploma": "Diploma de preparatoria", "Certification(s)": "Certificación(es)",
      "Associates Degree": "Título técnico (Associate)", "Bachelor's Degree": "Licenciatura", "Graduate Degree": "Posgrado",
    },
  },

  // Work history
  70: { text: "Historial laboral", nextButtonText: NEXT },
  362: { text: "<p><strong>Enumere su historial de trabajo completo en orden. Comience con su trabajo actual o más reciente (si está desempleado).</strong></p>" },
  385: {
    text: "Si aún no ha tenido un trabajo o es estudiante, marque la casilla correspondiente.",
    options: { "I am currently a student": "Actualmente soy estudiante", "I do not have job experience to enter": "No tengo experiencia laboral que ingresar" },
  },
  372: { text: "Enumere cualquier habilidad o experiencia relevante." },
  323: { text: "Si está empleado actualmente, ¿podemos contactar a su empleador actual para verificar su empleo?", options: { Yes: "Sí", "Unemployed/NA": "Desempleado / No aplica" } },
  72: { text: "1. Nombre del empleador" },
  280: { text: "Ubicación" },
  75: { text: "Número de teléfono" },
  76: { text: "Su puesto" },
  380: { text: "Describa su función y responsabilidades" },
  363: { text: "<p><strong>Fechas de empleo:</strong></p>" },
  348: { text: "Fecha de inicio (MM/AÑO)" },
  377: { text: "Fecha de fin (MM/AÑO)" },
  80: { text: "Nombre del supervisor" },
  81: { text: "Puesto del supervisor" },
  352: { text: "Motivo de la salida (sea específico)" },
  83: { text: "2. Nombre del empleador" },
  85: { text: "Ubicación" },
  86: { text: "Número de teléfono" },
  87: { text: "Su puesto / responsabilidad" },
  381: { text: "Describa su función y responsabilidades" },
  364: { text: "<p><strong>Fechas de empleo:</strong></p>" },
  349: { text: "Fecha de inicio (MM/AÑO)" },
  378: { text: "Fecha de fin (MM/AÑO)" },
  92: { text: "Nombre del supervisor" },
  93: { text: "Puesto del supervisor" },
  94: { text: "Motivo de la salida (sea específico)" },
  95: { text: "3. Nombre del empleador" },
  287: { text: "Ubicación" },
  98: { text: "Número de teléfono" },
  99: { text: "Su puesto / responsabilidad" },
  382: { text: "Describa su función y responsabilidades" },
  365: { text: "<p><strong>Fechas de empleo:</strong></p>" },
  350: { text: "Fecha de inicio (MM/AÑO)" },
  379: { text: "Fecha de fin (MM/AÑO)" },
  105: { text: "Nombre del supervisor" },
  106: { text: "Puesto del supervisor" },
  107: { text: "Motivo de la salida (sea específico)" },
  276: { text: "Puede comentar cualquier otra cualificación especial que tenga relacionada con este trabajo o esta empresa.", hint: TYPE_HERE },
  387: { text: "Si tiene un currículum, puede subirlo aquí:", buttonText: "Buscar archivos" },
  393: { text: "Si tiene un portafolio, puede subirlo aquí:", buttonText: "Buscar archivos" },
  394: { text: "Enlace a su portafolio", subLabel: "Si tiene un portafolio o sitio web en línea que muestre su trabajo, incluya el enlace aquí." },

  // Job-related background
  189: { text: "Antecedentes relacionados con el trabajo", nextButtonText: NEXT },
  313: { text: "¿Puede cumplir con los deberes y responsabilidades del puesto o los puestos que solicita, tal como se le han descrito en nuestra(s) descripción(es) de puesto por escrito, con o sin un ajuste razonable?", options: SI_NO },

  // Agreement and release
  216: { text: "Acuerdo y liberación", nextButtonText: NEXT },
  217: { text: '<p><span style="font-weight: bold; color: #000000;">LEA TODA LA SIGUIENTE SECCIÓN, AQUÍ Y EN LA PÁGINA SIGUIENTE, ANTES DE FIRMAR.</span></p>\n<p><span style="color: #000000;">Ponga sus iniciales en cada sección, en la columna central, para indicar que la ha leído y está de acuerdo con ella. Firme al final de esta solicitud en la página siguiente.</span></p>' },
  218: { text: "CON ESTA SOLICITUD, POR MI FIRMA A CONTINUACIÓN, ACEPTO TODOS LOS TÉRMINOS SIGUIENTES:", nextButtonText: NEXT },
  219: { text: `${TERM_HEAD}\n<p>Certifico que la información que he proporcionado en este formulario de solicitud y en mi currículum (si corresponde) es verdadera y correcta a mi leal saber y entender.</p>\n<p>Entiendo que cualquier tergiversación, falsificación u omisión de información importante en esta solicitud puede dar lugar a que no reciba una oferta o, si soy contratado, a la terminación de mi empleo.</p>` },
  324: { text: "Iniciales" },
  325: { text: `${TERM_HEAD}\n<p>En caso de que se me pida someterme a un examen o evaluación médica como parte del proceso de colocación laboral de la Compañía, acepto proporcionar únicamente información verdadera y correcta a mi leal saber y entender.</p>\n<p>Si la Compañía determina que he hecho declaraciones falsas, orales o escritas, tergiversaciones u omisiones de información importante a la Compañía, al médico o a su representante, la Compañía tiene derecho a retirar mi oferta condicional de empleo o a terminar mi empleo en cualquier momento.</p>` },
  326: { text: "Iniciales" },
  327: { text: `${TERM_HEAD}\n<p>Autorizo a cualquier persona, escuela, empleador actual, empleador anterior, médico u organización que tenga conocimiento de mí o de mi trabajo a proporcionar a la Compañía, o a su agente o representante, cualquier información u opinión sobre mí en respuesta a una consulta de la Compañía.</p>\n<p>Eximo a dicha persona, empleador, médico u organización de toda responsabilidad legal por hacer tales declaraciones o por proporcionar cualquier información a la Compañía o a su representante o agente.</p>` },
  328: { text: "Iniciales" },
  329: { text: `${TERM_HEAD}\n<p>Autorizo a la Compañía, a sus agentes o representantes a verificar referencias sobre mi empleo y a investigar cualquiera de las declaraciones o respuestas que he dado en esta solicitud o directamente a un representante de la Compañía. La única excepción a esta autorización es cuando yo haya solicitado específicamente por escrito, en este formulario de solicitud, que no se haga tal consulta.</p>` },
  330: { text: "Iniciales" },
  331: { text: `${TERM_HEAD}\n<p>Entiendo que mi empleo en esta Compañía es "a voluntad" (es decir, por consentimiento mutuo). Por lo tanto, acepto que tanto yo como la Compañía tenemos el derecho de terminar mi empleo, con o sin causa, en cualquier momento.</p>` },
  332: { text: "Iniciales" },
  322: { text: "Rexius considera que el uso de drogas o alcohol en el lugar de trabajo es una práctica laboral insegura y crea un mayor riesgo para el consumidor, los compañeros de trabajo, los clientes y el público. Rexius es un lugar de trabajo libre de drogas y alcohol. El uso de sustancias ilegales o el abuso de sustancias controladas puede dar lugar a medidas disciplinarias o a la terminación del empleo. Si es contratado, ¿acepta cumplir con las normas de Rexius de un lugar de trabajo libre de drogas y alcohol?", options: SI_NO },
  333: { text: "He leído y comprendido, y acepto toda la sección anterior, titulada ACUERDO Y LIBERACIÓN." },

  // Drug test consent
  228: { text: "Formulario de consentimiento para pruebas de alcohol y drogas", nextButtonText: NEXT },
  238: { text: "Rexius ha solicitado que me someta a una prueba de drogas/alcohol según su Política de Alcohol y Drogas como parte de mi solicitud de empleo. En consecuencia, mediante mi firma a continuación, autorizo a Rexius, al Oficial de Revisión Médica y al laboratorio con licencia seleccionado por Rexius a realizar un análisis de orina en una muestra proporcionada por mí para detectar el uso de drogas. Consiento esta prueba y también doy mi permiso al laboratorio y al Oficial de Revisión Médica para divulgar los resultados de esta prueba de drogas a Rexius. Acepto que Rexius puede utilizar estos resultados para determinar mi idoneidad para el empleo. Si Rexius me emplea, acepto cualquier prueba de drogas/alcohol que la Compañía pueda requerir según su Política de Alcohol y Drogas. Si el laboratorio determina que la prueba no es válida, y si el laboratorio, el Oficial de Revisión Médica o Rexius consideran que corresponde otra prueba, acepto proporcionar otra(s) muestra(s) para pruebas adicionales. Entiendo que no se me informará de los resultados de mi prueba de drogas previa al empleo a menos que lo solicite dentro de los 60 días posteriores a la notificación de la decisión sobre mi solicitud." },
  347: { text: "Enviar", clearText: "Borrar todas las respuestas" },
};

// Questions that carry no visible text and need no translation.
export const SKIP_TYPES = new Set(["control_divider", "control_pagebreak"]);
