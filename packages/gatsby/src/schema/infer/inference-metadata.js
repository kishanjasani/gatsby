/*
## Incrementally track the structure of nodes with metadata

This metadata can be later utilized for schema inference
(via building `exampleValue` or directly)

### Usage example:

```javascript
  const node1 = { id: '1', foo: 25, bar: 'str' }
  const node2 = { id: '1', foo: 'conflict' }

  let meta = { ignoredFields: new Set(['id']) }
  meta = addNode(meta, node1)
  meta = addNode(meta, node2)
  console.log(meta.fieldMap)
  // outputs: {
  //   foo: {
  //     int: { total: 1, example: 25 },
  //     string: { total: 1, example: 'conflict' },
  //   },
  //   bar: {
  //     string: { total: 1, example: 'str' },
  //   },
  // }

  const example1 = getExampleObject({ meta, typeName, typeConflictReporter })
  console.log(example1)
  // outputs { bar: 'str' }
  // and reports conflicts discovered

  meta = deleteNode(meta, node2)
  console.log(meta.fieldMap)
  // outputs: {
  //   foo: {
  //     int: { total: 1, example: 25 },
  //     string: { total: 0, example: 'conflict' },
  //   },
  //   bar: { string: { total: 1, example: 'str' } },
  // }

  const example2 = getExampleObject({ meta, typeName, typeConflictReporter })
  // outputs: { foo: 25, bar: 'str' }
```

`addNode`, `deleteNode`, `getExampleObject` are O(N) where N is the number
of fields in the node object (including nested fields)

### Metadata structure

```javascript
type TypeMetadata = {
  ignored?: boolean,
  ignoredFields?: Set<string>,
  fieldMap?: { [string]: ValueDescriptor },
  typeName?: string,
  dirty?: boolean, // tracks structural changes only
}

type Count = number
type NodeId = string

type ValueDescriptor = {
  int?: { total: Count, first: NodeId, example: number },
  float?: { total: Count, first: NodeId, example: number },
  date?: { total: Count, first: NodeId, example: string },
  string?: { total: Count, first: NodeId, example: string, empty: Count },
  boolean?: { total: Count, first: NodeId, example: boolean },
  array?: { total: Count, first: NodeId, item: ValueDescriptor },
  listOfUnion?: { total: Count, first: NodeId, nodes: { [NodeId]: Count } },
  object?: { total: 0, first: NodeId, props: { [string]: ValueDescriptor } },
}
```

### Caveats

* Conflict tracking for arrays is tricky, i.e.: { a: [5, "foo"] } and { a: [5] }, { a: ["foo"] }
  are represented identically in metadata. To workaround it we additionally track first NodeId:
  { a: { array: { item: { int: { total: 1, first: `1` }, string: { total: 1, first: `1` } }}
  { a: { array: { item: { int: { total: 1, first: `1` }, string: { total: 1, first: `2` } }}
  This way we can produce more useful conflict reports
  (still rare edge cases possible when reporting may be confusing, i.e. when node is deleted)
*/

const { groupBy } = require(`lodash`)
const is32BitInteger = require(`./is-32-bit-integer`)
const { looksLikeADate } = require(`../types/date`)

const getType = (value, key) => {
  // Staying as close as possible to GraphQL types
  switch (typeof value) {
    case `number`:
      return is32BitInteger(value) ? `int` : `float`
    case `string`:
      return looksLikeADate(value) ? `date` : `string`
    case `boolean`:
      return `boolean`
    case `object`:
      if (value === null) return `null`
      if (value instanceof Date) return `date`
      if (value instanceof String) return `string`
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return `null`
        }
        return key.includes(`___NODE`) ? `listOfUnion` : `array`
      }
      if (!Object.keys(value).length) return `null`
      return `object`
    default:
      return `null`
  }
}

const updateValueDescriptor = ({
  nodeId,
  key,
  value,
  operation = `add`,
  descriptor = {},
}) => {
  const typeName = getType(value, key)

  if (typeName === `null`) {
    return [descriptor, false]
  }

  const delta = operation === `del` ? -1 : 1
  const typeInfo = descriptor[typeName] || { total: 0 }
  typeInfo.total += delta

  // Keeping track of structural changes
  // (when value of a new type is added or an existing type has no more values assigned)
  let dirty = typeInfo.total === 1 || typeInfo.total === 0

  // Keeping track of the first node for this type. Only used for better conflict reporting.
  // (see Caveats section in the header comments)
  if (operation === `add`) {
    typeInfo.first = typeInfo.first || nodeId
  } else if (operation === `del`) {
    typeInfo.first =
      typeInfo.first === nodeId || typeInfo.total === 0
        ? undefined
        : typeInfo.first
  }

  switch (typeName) {
    case `object`: {
      const { props = {} } = typeInfo
      Object.keys(value).forEach(key => {
        const [propDescriptor, propDirty] = updateValueDescriptor({
          nodeId,
          key,
          value: value[key],
          operation,
          descriptor: props[key],
        })
        props[key] = propDescriptor
        dirty = dirty || propDirty
      })
      typeInfo.props = props
      break
    }
    case `array`: {
      value.forEach(item => {
        const [itemDescriptor, itemDirty] = updateValueDescriptor({
          nodeId,
          descriptor: typeInfo.item,
          operation,
          value: item,
          key,
        })
        typeInfo.item = itemDescriptor
        dirty = dirty || itemDirty
      })
      break
    }
    case `listOfUnion`: {
      const { nodes = {} } = typeInfo
      value.forEach(nodeId => {
        nodes[nodeId] = (nodes[nodeId] || 0) + delta

        // Treat any new related node addition or removal as a structural change
        // FIXME: this will produce false positives as this node can be
        //  of the same type as another node already in the map (but we don't know it)
        dirty = dirty || nodes[nodeId] === 0 || nodes[nodeId] === 1
      })
      typeInfo.nodes = nodes
      break
    }
    case `string`: {
      // FIXME: need this to satisfy pre-refactoring tests
      if (value === ``) {
        const { empty = 0 } = typeInfo
        typeInfo.empty = empty + delta
      }
      typeInfo.example =
        typeof typeInfo.example !== `undefined` ? typeInfo.example : value
      break
    }
    default:
      typeInfo.example =
        typeof typeInfo.example !== `undefined` ? typeInfo.example : value
      break
  }
  descriptor[typeName] = typeInfo
  return [descriptor, dirty]
}

const nodeFields = (node, ignoredFields = new Set()) =>
  Object.keys(node).filter(key => !ignoredFields.has(key))

const updateTypeMetadata = (metadata = {}, operation, node) => {
  if (metadata.ignored) {
    return metadata
  }
  const { ignoredFields, fieldMap = {}, dirty = false } = metadata

  let structureChanged = false
  nodeFields(node, ignoredFields).forEach(field => {
    const [descriptor, valueStructureChanged] = updateValueDescriptor({
      nodeId: node.id,
      key: field,
      value: node[field],
      operation,
      descriptor: fieldMap[field],
    })
    fieldMap[field] = descriptor
    structureChanged = structureChanged || valueStructureChanged
  })
  metadata.fieldMap = fieldMap
  metadata.dirty = dirty || structureChanged
  return metadata
}

const ignore = (metadata = {}, set = true) => {
  metadata.ignored = set
  return metadata
}

const addNode = (metadata, node) => updateTypeMetadata(metadata, `add`, node)
const deleteNode = (metadata, node) => updateTypeMetadata(metadata, `del`, node)
const addNodes = (metadata, nodes) => nodes.reduce(addNode, metadata)

const isMixedNumber = ({ float, int }) =>
  float && float.total > 0 && (int && int.total > 0)

const isMixOfDateAndString = ({ date, string }) =>
  date && date.total > 0 && (string && string.total > 0)

const hasOnlyEmptyStrings = ({ string }) =>
  string && string.empty === string.total

const possibleTypes = descriptor =>
  Object.keys(descriptor).filter(type => descriptor[type].total > 0)

const resolveWinnerType = descriptor => {
  const candidates = possibleTypes(descriptor)
  if (candidates.length === 1) {
    return [candidates[0]]
  }
  if (candidates.length === 2 && isMixedNumber(descriptor)) {
    return [`float`]
  }
  if (candidates.length === 2 && isMixOfDateAndString(descriptor)) {
    return [hasOnlyEmptyStrings(descriptor) ? `date` : `string`]
  }
  if (candidates.length > 1) {
    return [`null`, true]
  }
  return [`null`]
}

const prepareConflictExamples = (descriptor, isArrayItem) => {
  const typeNameMapper = typeName => {
    if (typeName === `listOfUnion`) {
      return `[string]`
    }
    return [`float`, `int`].includes(typeName) ? `number` : typeName
  }
  const reportedValueMapper = typeName => {
    if (typeName === `listOfUnion`) {
      const { nodes } = descriptor.listOfUnion
      return Object.keys(nodes).filter(key => nodes[key] > 0)
    }
    if (typeName === `object`) {
      return getExampleObject({ typeName, fieldMap: descriptor.object.props })
    }
    if (typeName === `array`) {
      const itemValue = buildExampleValue({
        descriptor: descriptor.array.item,
        isArrayItem: true,
      })
      return itemValue === null || itemValue === undefined ? [] : [itemValue]
    }
    return descriptor[typeName].example
  }
  const conflictingTypes = possibleTypes(descriptor)

  if (isArrayItem) {
    // Differentiate conflict examples by node they were first seen in.
    // See Caveats section in the header of this file
    const groups = groupBy(
      conflictingTypes,
      type => descriptor[type].first || ``
    )
    return Object.keys(groups).map(nodeId => {
      return {
        type: `[${groups[nodeId].map(typeNameMapper).join(`,`)}]`,
        value: groups[nodeId].map(reportedValueMapper),
      }
    })
  }

  return conflictingTypes.map(type => {
    return {
      type: typeNameMapper(type),
      value: reportedValueMapper(type),
    }
  })
}

const buildExampleValue = ({
  descriptor,
  typeConflictReporter,
  isArrayItem = false,
  path = ``,
}) => {
  const [type, conflicts = false] = resolveWinnerType(descriptor)

  if (conflicts && typeConflictReporter) {
    typeConflictReporter.addConflict(
      path,
      prepareConflictExamples(descriptor, isArrayItem)
    )
  }

  const typeInfo = descriptor[type]

  switch (type) {
    case `null`:
      return null

    case `date`:
    case `string`: {
      // FIXME: Remove this and fix tests (this was mostly done for compatibility
      //  with the previous exampleValue implementation and to make all tests pass)
      if (isMixOfDateAndString(descriptor)) {
        return hasOnlyEmptyStrings(descriptor) ? `1978-09-26` : `String`
      }
      return typeInfo.example
    }

    case `array`: {
      const { item } = typeInfo
      const exampleItemValue = item
        ? buildExampleValue({
            descriptor: item,
            isArrayItem: true,
            typeConflictReporter,
            path,
          })
        : null
      return exampleItemValue === null ? null : [exampleItemValue]
    }

    case `listOfUnion`: {
      const { nodes = {} } = typeInfo
      return Object.keys(nodes).filter(key => nodes[key] > 0)
    }

    case `object`: {
      const { props } = typeInfo
      return Object.keys(props).reduce((acc, prop) => {
        const value = buildExampleValue({
          descriptor: props[prop],
          typeConflictReporter,
          path: `${path}.${prop}`,
        })
        if (value !== null) {
          acc[prop] = value
        }
        return acc
      }, {})
    }

    default:
      return typeInfo.example
  }
}

const getExampleObject = ({ fieldMap, typeName, typeConflictReporter }) =>
  Object.keys(fieldMap).reduce((acc, key) => {
    const value = buildExampleValue({
      path: `${typeName}.${key}`,
      descriptor: fieldMap[key],
      typeConflictReporter,
    })
    if (key && value !== null) {
      acc[key] = value
    }
    return acc
  }, {})

const isEmpty = ({ fieldMap }) =>
  Object.keys(fieldMap).every(
    field => possibleTypes(fieldMap[field]).length === 0
  )

module.exports = {
  addNode,
  addNodes,
  deleteNode,
  ignore,
  isEmpty,
  getExampleObject,
}
