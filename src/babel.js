import fs from 'fs'
import { basename } from 'path'
import { touchSync } from 'touch'
import { inline, keyframes, fontFace } from './inline'
import findAndReplaceAttrs from './attrs'

function parseDynamicValues (rules, t) {
  return rules.map(rule => {
    const re = /xxx(\S)xxx/gm
    let varMatch
    let matches = []
    while ((varMatch = re.exec(rule)) !== null) {
      matches.push({
        value: varMatch[0],
        p1: varMatch[1],
        index: varMatch.index
      })
    }

    let cursor = 0
    const [quasis, expressions] = matches.reduce(
      (accum, { value, p1, index }, i) => {
        const [quasis, expressions] = accum
        const preMatch = rule.substring(cursor, index)
        cursor = cursor + preMatch.length + value.length
        if (preMatch) {
          quasis.push(t.templateElement({ raw: preMatch, cooked: preMatch }))
        }

        expressions.push(t.identifier(`x${p1}`))

        if (i === matches.length - 1 && cursor <= rule.length) {
          const postMatch = rule.substring(cursor)

          quasis.push(
            t.templateElement(
              {
                raw: postMatch,
                cooked: postMatch
              },
              true
            )
          )
        }
        return accum
      },
      [[], []]
    )

    if (!matches.length) {
      return t.templateLiteral(
        [t.templateElement({ raw: rule, cooked: rule }, true)],
        []
      )
    }

    return t.templateLiteral(quasis, expressions)
  })
}

export default function (babel) {
  const { types: t } = babel

  return {
    name: 'emotion', // not required
    inherits: require('babel-plugin-syntax-jsx'),
    visitor: {
      Program: {
        enter (path, state) {
          state.inline =
            path.hub.file.opts.filename === 'unknown' || state.opts.inline
          state.staticRules = []
          state.insertStaticRules = function (staticRules) {
            state.staticRules.push(...staticRules)
          }
        },
        exit (path, state) {
          if (state.staticRules.length !== 0) {
            const toWrite = state.staticRules.join('\n').trim()
            const filenameArr = path.hub.file.opts.filename.split('.')
            filenameArr.pop()
            filenameArr.push('emotion', 'css')
            const cssFilename = filenameArr.join('.')
            const exists = fs.existsSync(cssFilename)
            path.node.body.unshift(
              t.importDeclaration(
                [],
                t.stringLiteral('./' + basename(cssFilename))
              )
            )
            if (
              exists ? fs.readFileSync(cssFilename, 'utf8') !== toWrite : true
            ) {
              if (!exists) {
                touchSync(cssFilename)
              }
              fs.writeFileSync(cssFilename, toWrite)
            }
          }
        }
      },
      TaggedTemplateExpression (path, state) {
        // in:
        // styled.h1`color:${color};`
        //
        // out:
        // styled('h1', "css-r1aqtk", [colorVar, heightVar], function inlineCss(x0, x1) {
        //   return [`.css-r1aqtk {
        //     margin: 12px;
        //     color: ${x0};
        //     height: ${x1}; }`];
        // });

        const parent = path.findParent(p => p.isVariableDeclarator())
        const identifierName = parent && t.isIdentifier(parent.node.id)
          ? parent.node.id.name
          : ''

        function buildCallExpression (identifier, tag, path) {
          const built = findAndReplaceAttrs(path, t)

          let { hash, rules, name, isStatic } = inline(
            built,
            identifierName,
            'css',
            state.inline
          )

          // hash will be '0' when no styles are passed so we can just return the original tag
          if (hash === '0') {
            return tag
          }
          const args = [
            tag,
            t.stringLiteral(`${name}-${hash}`),
            t.arrayExpression(built.expressions)
          ]
          if (isStatic) {
            state.insertStaticRules(rules)
          } else {
            const inlineContentExpr = t.functionExpression(
              t.identifier('createEmotionStyledRules'),
              built.expressions.map((x, i) => t.identifier(`x${i}`)),
              t.blockStatement([
                t.returnStatement(
                  t.arrayExpression(parseDynamicValues(rules, t))
                )
              ])
            )
            args.push(inlineContentExpr)
          }

          return t.callExpression(identifier, args)
        }

        if (
          // styled.h1`color:${color};`
          t.isMemberExpression(path.node.tag) &&
          path.node.tag.object.name === 'styled' &&
          t.isTemplateLiteral(path.node.quasi)
        ) {
          path.replaceWith(
            buildCallExpression(
              path.node.tag.object,
              t.stringLiteral(path.node.tag.property.name),
              path
            )
          )
        } else if (
          // styled('h1')`color:${color};`
          t.isCallExpression(path.node.tag) &&
          path.node.tag.callee.name === 'styled' &&
          t.isTemplateLiteral(path.node.quasi)
        ) {
          path.replaceWith(
            buildCallExpression(
              path.node.tag.callee,
              path.node.tag.arguments[0],
              path
            )
          )
        } else if (
          t.isIdentifier(path.node.tag) &&
          path.node.tag.name === 'fragment'
        ) {
          const { rules } = inline(
            path.node.quasi,
            identifierName,
            'frag',
            true
          )
          if (rules.length > 1) {
            throw path.buildCodeFrameError(
              'Fragments cannot have multiple selectors.'
            )
          }
          const rulesWithoutSelector = rules.map(rule =>
            rule.substring(rule.indexOf('{') + 1, rule.length - 1)
          )
          const dynamicRules = parseDynamicValues(rulesWithoutSelector, t)
          path.replaceWith(
            t.callExpression(t.identifier('fragment'), [
              t.arrayExpression(path.node.quasi.expressions),
              t.functionExpression(
                t.identifier('createEmotionFragment'),
                path.node.quasi.expressions.map((x, i) =>
                  t.identifier(`x${i}`)
                ),
                t.blockStatement([t.returnStatement(dynamicRules[0])])
              )
            ])
          )
        } else if (
          t.isIdentifier(path.node.tag) &&
          path.node.tag.name === 'css'
        ) {
          const { hash, name, rules, isStatic } = inline(
            path.node.quasi,
            identifierName,
            'css',
            state.inline
          )
          const args = [
            t.stringLiteral(`${name}-${hash}`),
            t.arrayExpression(path.node.quasi.expressions)
          ]
          if (isStatic) {
            state.insertStaticRules(rules)
          } else {
            const inlineContentExpr = t.functionExpression(
              t.identifier('createEmotionRules'),
              path.node.quasi.expressions.map((x, i) => t.identifier(`x${i}`)),
              t.blockStatement([
                t.returnStatement(
                  t.arrayExpression(parseDynamicValues(rules, t))
                )
              ])
            )
            args.push(inlineContentExpr)
          }
          path.replaceWith(t.callExpression(t.identifier('css'), args))
        } else if (
          t.isIdentifier(path.node.tag) &&
          path.node.tag.name === 'keyframes'
        ) {
          const { hash, name, rules } = keyframes(
            path.node.quasi,
            identifierName,
            'animation'
          )

          path.replaceWith(
            t.callExpression(t.identifier('keyframes'), [
              t.stringLiteral(`${name}-${hash}`),
              t.arrayExpression(path.node.quasi.expressions),
              t.functionExpression(
                t.identifier('createEmotionKeyframe'),
                path.node.quasi.expressions.map((x, i) =>
                  t.identifier(`x${i}`)
                ),
                t.blockStatement([
                  t.returnStatement(
                    t.arrayExpression(rules.map(r => t.stringLiteral(r)))
                  )
                ])
              )
            ])
          )
        } else if (
          t.isIdentifier(path.node.tag) &&
          path.node.tag.name === 'fontFace'
        ) {
          const { hash, name, rules } = fontFace(
            path.node.quasi,
            identifierName,
            'font-face'
          )

          path.replaceWith(
            t.callExpression(t.identifier('fontFace'), [
              t.stringLiteral(`${name}-${hash}`),
              t.arrayExpression(path.node.quasi.expressions),
              t.functionExpression(
                t.identifier('createEmotionFontFace'),
                path.node.quasi.expressions.map((x, i) =>
                  t.identifier(`x${i}`)
                ),
                t.blockStatement([
                  t.returnStatement(
                    t.arrayExpression(rules.map(r => t.stringLiteral(r)))
                  )
                ])
              )
            ])
          )
        }
      }
    }
  }
}
