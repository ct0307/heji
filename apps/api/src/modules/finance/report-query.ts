import { ApiFault } from '../../shared/errors.ts';
import { businessDate } from './validation.ts';

export function reportPeriod(query:Record<string,unknown>) {
  if(Object.keys(query).some(key=>!['from','to'].includes(key))||Object.values(query).some(value=>typeof value!=='string'))throw new ApiFault(422,'INVALID_QUERY','统计筛选参数无效');
  const from=query.from===undefined?null:businessDate(query.from),to=query.to===undefined?null:businessDate(query.to);
  if(from&&to&&from>to)throw new ApiFault(422,'INVALID_QUERY','开始日期不能晚于结束日期');
  // 结束日包含当天，SQL使用次日零点作为半开区间上界。9999-12-31没有MySQL可表达的下一天。
  const until=to&&to<'9999-12-31'?new Date(new Date(to+'T00:00:00Z').getTime()+86400000).toISOString().slice(0,10):null;
  return {from,to,until};
}
