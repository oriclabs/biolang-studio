import { useMemo, useState } from "react";
import { generateStatisticsNotebook, STATISTICS_TASKS } from "./statistics-guide";

export function StatisticsGuideDialog(props: { close: () => void; create: (title: string, source: string) => void }) {
  const [taskId, setTaskId] = useState(STATISTICS_TASKS[0].id);
  const task = useMemo(() => STATISTICS_TASKS.find(item => item.id === taskId)!, [taskId]);
  const [path, setPath] = useState("measurements.csv");
  const [columns, setColumns] = useState(task.columns);
  const [method, setMethod] = useState(task.defaultMethod);
  const [error, setError] = useState("");

  function selectTask(id: string) {
    const next = STATISTICS_TASKS.find(item => item.id === id)!;
    setTaskId(id); setColumns(next.columns); setMethod(next.defaultMethod); setError("");
  }

  return <div className="modal-backdrop"><form className="modal statistics-guide-modal" onSubmit={event => {
    event.preventDefault();
    try { props.create(task.title, generateStatisticsNotebook(task.id, path.trim(), columns, method)); }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
  }}>
    <h2>New guided statistics notebook</h2>
    <p>Choose the question and state the data columns. Studio writes editable BioLang and keeps the method visible.</p>
    {error && <p className="guide-error" role="alert">{error}</p>}
    <label>Question<select value={taskId} onChange={event => selectTask(event.target.value)}>{STATISTICS_TASKS.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <p className="guide-question">{task.question}</p>
    <label>Attached CSV path<input required value={path} onChange={event => setPath(event.target.value)} placeholder="measurements.csv" /></label>
    <label>Columns, in the stated order<input required value={columns} onChange={event => setColumns(event.target.value)} placeholder={task.columns} /></label>
    <label>Method<select value={method} onChange={event => setMethod(event.target.value)}>{task.methods.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
    <p className="modal-guidance">The guide does not infer whether rows are independent or paired, choose an experimental unit, remove outliers, or transform the data.</p>
    <div><button type="button" onClick={props.close}>Cancel</button><button className="primary" type="submit">Create notebook</button></div>
  </form></div>;
}
