// Read actual Cubby schemas; do not infer a record contract from a toy row.
import {
  taskListItemOut,
  taskOut,
  taskUpdateData,
} from "@cubby/schemas/project";
const list = Object.keys(taskListItemOut.shape);
const detail = Object.keys(taskOut.shape);
const update = Object.keys(taskUpdateData.shape);
console.log(
  JSON.stringify(
    {
      listFields: list,
      detailOnly: detail.filter((key) => !list.includes(key)),
      listOnly: list.filter((key) => !detail.includes(key)),
      writable: update,
      projectionNameTypes: {
        list: taskListItemOut.shape.name.type,
        detail: taskOut.shape.name.type,
      },
    },
    null,
    2,
  ),
);
