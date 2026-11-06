export function correctionTarget(snapshot, kind, assertion) {
  if (!snapshot?.revision) throw new Error('请先查看当前对象；历史视图不能直接提交修正');
  if (kind === 'CorrectProperty') return { id: snapshot.id, revision: snapshot.revision, label: '当前对象' };
  if (!assertion || !snapshot.assertions.some(a => a.id === assertion.id && a.revision === assertion.revision)) throw new Error('请先在声明旁选择“修正此声明时间”，再选择时间修正或否决');
  return { id: assertion.id, revision: assertion.revision, label: '选中的声明' };
}
export function fillCorrectionTarget(form, target) {
  form.elements.targetId.value = target?.id ?? '';
  form.elements.expectedRevision.value = target?.revision ?? '';
  form.elements.targetId.readOnly = true;
  form.elements.expectedRevision.readOnly = true;
}
