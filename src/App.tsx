import "./styles.css";

const project = {
  "id": "hxwl-01",
  "port": 5101,
  "title": "听力验配记录",
  "subtitle": "门店听力师的验配档案与听力曲线工作台",
  "stack": "React + Vite + TypeScript + CSS",
  "theme": [
    "#155e75",
    "#22c55e",
    "#f97316"
  ],
  "domain": "听力验配",
  "users": [
    "听力师",
    "门店主管",
    "复诊助理"
  ],
  "metrics": [
    "左耳PTA",
    "右耳PTA",
    "言语识别率",
    "复诊天数"
  ],
  "filters": [
    "初配",
    "复调",
    "儿童",
    "老人"
  ],
  "fields": [
    "气导",
    "骨导",
    "言语识别率",
    "助听器型号",
    "增益调整",
    "用户反馈"
  ],
  "records": [
    [
      "Liu-024",
      "双耳高频下降",
      "初配",
      "RIC机型，2kHz后增益提高4dB"
    ],
    [
      "Chen-118",
      "单侧传导性损失",
      "复调",
      "低频压缩略降，反馈啸叫已消失"
    ],
    [
      "Zhao-077",
      "老人语频区下降",
      "复诊",
      "言语识别率从64%提升到76%"
    ]
  ]
};

const statusColors = ["status-ok", "status-watch", "status-danger"];

function MetricCard({ label, value, index }: { label: string; value: string; index: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={statusColors[index % statusColors.length]} />
    </article>
  );
}

function App() {
  const values = project.metrics.map((metric: string, index: number) => {
    const base = [84, 12, 31, 7][index % 4];
    return String(base + index * 3);
  });

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>技术栈</span>
          <strong>{project.stack}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        {project.metrics.map((metric: string, index: number) => (
          <MetricCard key={metric} label={metric} value={values[index]} index={index} />
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>角色</h2>
          <div className="chips">
            {project.users.map((user: string) => (
              <span key={user}>{user}</span>
            ))}
          </div>
          <h2>筛选</h2>
          <div className="chips muted">
            {project.filters.map((filter: string) => (
              <button key={filter}>{filter}</button>
            ))}
          </div>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>{project.domain}</p>
              <h2>记录字段</h2>
            </div>
            <button className="primary-action">新增记录</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>示例数据</p>
            <h2>近期记录</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="record-list">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")} className="record-card">
              <div className="record-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
