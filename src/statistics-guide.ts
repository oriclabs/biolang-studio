export type StatisticsTask = {
  id: string; title: string; question: string; columns: string;
  minimumColumns: number; exactColumns?: number; defaultMethod: string; methods: string[];
};

export const STATISTICS_TASKS: StatisticsTask[] = [
  { id: "compare", title: "Compare two independent groups", question: "Do two independent groups differ?", columns: "control,treated", minimumColumns: 2, exactColumns: 2, defaultMethod: "welch", methods: ["welch", "student", "mann_whitney", "permutation_mean"] },
  { id: "compare-many", title: "Compare several independent groups", question: "Do several independent groups differ?", columns: "control,low,high", minimumColumns: 2, defaultMethod: "welch_anova", methods: ["welch_anova", "classical_anova", "kruskal_wallis"] },
  { id: "counts", title: "Test association in a count table", question: "Are two categorical variables associated?", columns: "outcome_yes,outcome_no", minimumColumns: 2, defaultMethod: "chi_square", methods: ["chi_square", "fisher"] },
  { id: "stratified", title: "Check odds-ratio homogeneity", question: "Is one common odds ratio plausible across strata?", columns: "a,b,c,d", minimumColumns: 4, exactColumns: 4, defaultMethod: "breslow_day_tarone_adjusted", methods: ["breslow_day_tarone_adjusted"] },
  { id: "relationship", title: "Study a numeric relationship", question: "How are two numeric measurements related?", columns: "x,y", minimumColumns: 2, exactColumns: 2, defaultMethod: "linear", methods: ["linear", "pearson", "spearman", "kendall"] },
  { id: "paired", title: "Compare matched measurements", question: "Did a measurement change within matched pairs?", columns: "before,after", minimumColumns: 2, exactColumns: 2, defaultMethod: "paired_t", methods: ["paired_t", "paired_wilcoxon"] },
  { id: "dose-response", title: "Study a dose-response trend", question: "Does the outcome change with dose?", columns: "dose,outcome", minimumColumns: 2, exactColumns: 2, defaultMethod: "linear", methods: ["linear", "spearman"] },
  { id: "survival", title: "Summarize time-to-event data", question: "What is the survival experience over time?", columns: "time,event", minimumColumns: 2, exactColumns: 2, defaultMethod: "kaplan_meier", methods: ["kaplan_meier"] },
  { id: "meta", title: "Combine study estimates", question: "What pooled effect is supported by several studies?", columns: "effect,variance", minimumColumns: 2, exactColumns: 2, defaultMethod: "fixed", methods: ["fixed", "random"] },
];

const quoted = (value: string) => JSON.stringify(value);
const column = (name: string) => `data[${quoted(name)}]`;

export function generateStatisticsNotebook(taskId: string, path: string, rawColumns: string, method: string) {
  const task = STATISTICS_TASKS.find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`Unknown statistics task '${taskId}'.`);
  const columns = rawColumns.split(",").map(value => value.trim()).filter(Boolean);
  if (columns.length < task.minimumColumns || (task.exactColumns && columns.length !== task.exactColumns)) {
    const amount = task.exactColumns ? `exactly ${task.exactColumns}` : `at least ${task.minimumColumns}`;
    throw new Error(`${task.title} needs ${amount} columns, for example ${task.columns}.`);
  }
  if (!task.methods.includes(method)) throw new Error(`Method '${method}' is not available for this question.`);
  const option = `{method: ${quoted(method)}}`;
  let call = "";
  if (task.id === "compare") call = `stat.compare_groups(${column(columns[0])}, ${column(columns[1])}, ${option})`;
  else if (task.id === "compare-many") call = `stat.compare_many([${columns.map(column).join(", ")}], ${option})`;
  else if (task.id === "counts") {
    const row = columns.map(name => `${column(name)}[i]`).join(", ");
    call = `stat.count_association(range(0, len(${column(columns[0])})) |> map(|i| [${row}]), ${option})`;
  } else if (task.id === "stratified") {
    const [a, b, c, d] = columns.map(column);
    call = `stat.stratified_association(range(0, len(${a})) |> map(|i| [[${a}[i], ${b}[i]], [${c}[i], ${d}[i]]]))`;
  } else if (task.id === "relationship") call = `stat.numeric_relationship(${column(columns[0])}, ${column(columns[1])}, ${option})`;
  else if (task.id === "paired") call = `stat.paired_change(${column(columns[0])}, ${column(columns[1])}, ${option})`;
  else if (task.id === "dose-response") call = `stat.dose_response(${column(columns[0])}, ${column(columns[1])}, ${option})`;
  else if (task.id === "survival") call = `stat.survival_summary(${column(columns[0])}, ${column(columns[1])})`;
  else if (task.id === "meta") call = `stat.meta_summary(${column(columns[0])}, ${column(columns[1])}, ${option})`;

  return `# ${task.title}

## Question

${task.question}

The method is **${method}**. It is explicit so another analyst can reproduce or change it. BioLang does not infer pairing, independence, study design, or experimental units.

## Load and inspect the data

\`\`\`biolang
import "statistics" as stat

let data = read_csv(${quoted(path)})
{rows: nrow(data), columns: colnames(data)}
\`\`\`

Confirm that one row represents the intended observational unit and review missing values before interpreting a test.

## Run the stated analysis

\`\`\`biolang
let result = ${call}
stat.show(result, {detail: "learning", format: "auto"})
\`\`\`

## Inspect the full result

\`\`\`biolang
result
\`\`\`

Read the effect estimate and interval before the p-value. Review \`result.assumptions\`, \`result.alternatives\`, and \`result.reproducible_call\`; the helper never changes the input data.
`;
}
