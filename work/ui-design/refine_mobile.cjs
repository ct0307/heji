const fs = require('fs');
const path = require('path');
const project = path.resolve(__dirname, '../..');
const content = path.join(project, '.superpowers/brainstorm/ui-20261110-02/content');
const source = fs.readFileSync(path.join(content, 'visual-directions-v2.html'), 'utf8');
const refinement = `
/* 手机以核对待办为先；标题均衡换行，避免单字孤行。 */
@media(max-width:760px){
 h1{text-wrap:balance}
 .page-description{font-size:11px}
 .metric p{font-size:11px}
 .balance-caption{font-size:11px}
 .balance-foot{font-size:10px}
 .expense-title{font-size:14px}
 .expense-meta{font-size:11px}
 .pending-copy{font-size:12px}
 .pending-title{font-size:14px}
 .content-grid .right-stack{display:contents}
 .content-grid .pending-card{order:-1;width:100%}
 .content-grid .right-stack>.panel{order:1;width:100%}
}
`;
const result = source.replace('</style>', `${refinement}</style>`)
  .replace('>UI DESIGN STUDY</span>', '>界面草图 · 模拟数据</span>');
if (result === source) throw new Error('未应用手机排版修订');
fs.writeFileSync(path.join(content, 'visual-directions-v3.html'), result, { encoding: 'utf8', flag: 'wx' });
console.log('已生成 visual-directions-v3.html，保留此前视觉方案。');
