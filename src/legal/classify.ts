// Classificação do ato processual → etapa do funil Suporte e Pós-venda.
export type Etapa = 'andamento' | 'audiencia' | 'sentenca' | 'recurso' | 'cumprimento';

export const ETAPA_STAGE: Record<Etapa, string> = {
  andamento: process.env.STAGE_ANDAMENTO || '',
  audiencia: process.env.STAGE_AUDIENCIA || '',
  sentenca: process.env.STAGE_SENTENCA || '',
  recurso: process.env.STAGE_RECURSO || '',
  cumprimento: process.env.STAGE_CUMPRIMENTO || '',
};
export const ETAPA_ROTULO: Record<Etapa, string> = {
  andamento: 'Em andamento', audiencia: 'Audiência/perícia marcada', sentenca: 'Decisão/sentença',
  recurso: 'Recurso/acórdão', cumprimento: 'Cumprimento/execução',
};

export const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Ordem de precedência: cumprimento > recurso > sentença > audiência > andamento. */
export function classificar(tipo: string, texto: string): { etapa: Etapa; urgente: boolean } {
  const t = semAcento(`${tipo} \n ${texto.slice(0, 4000)}`);
  const tem = (re: RegExp) => re.test(t);
  if (tem(/cumprimento de sentenca|execucao (de|da|contra)|\brpv\b|requisicao de pequeno valor|precatorio|alvara|levantamento de (valor|deposito)/))
    return { etapa: 'cumprimento', urgente: false };
  if (tem(/\bacordao\b|turma recursal|sessao (plenaria )?virtual|julgamento (do|da) (recurso|apelacao|agravo)|camara (civel|criminal)|\bapelacao\b|agravo de instrumento|embargos de declaracao/))
    return { etapa: 'recurso', urgente: tem(/\bacordao\b/) };
  if (tem(/\bsentenca\b|julgo (parcialmente )?(procedente|improcedente)|homologo|extingo o processo|resolucao do merito/))
    return { etapa: 'sentenca', urgente: true };
  if (tem(/audiencia|pericia|avaliacao social|designad[oa] (para|o dia)/))
    return { etapa: 'audiencia', urgente: true };
  return { etapa: 'andamento', urgente: false };
}

const CNJ = /\b(\d{7})-?(\d{2})\.?(\d{4})\.?(\d)\.?(\d{2})\.?(\d{4})\b/g;
export function extrairCnjs(texto: string): string[] {
  const out = new Set<string>();
  for (const m of texto.matchAll(CNJ)) out.add(`${m[1]}-${m[2]}.${m[3]}.${m[4]}.${m[5]}.${m[6]}`);
  return [...out];
}
