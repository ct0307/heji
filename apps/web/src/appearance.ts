export type Appearance = 'a'|'b';
export interface AppearanceStorage {
  getItem(key:string):string|null;
  setItem(key:string,value:string):void;
}
export const APPEARANCE_STORAGE_KEY='heji.interface';

export function loadAppearance(storage?:AppearanceStorage):Appearance{
  try{return storage?.getItem(APPEARANCE_STORAGE_KEY)==='b'?'b':'a'}
  catch{return 'a'}
}

export function saveAppearance(value:Appearance,storage?:AppearanceStorage):boolean{
  if(!storage)return false;
  try{storage.setItem(APPEARANCE_STORAGE_KEY,value);return true}
  catch{return false}
}
