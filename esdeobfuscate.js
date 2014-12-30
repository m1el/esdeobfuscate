var esdeobfuscate = (function() {
    var boperators = {
        '+': function(a, b) { return a + b; },
        '-': function(a, b) { return a - b; },
        '*': function(a, b) { return a * b; },
        '/': function(a, b) { return a / b; },
        '||': function(a, b) { return a || b; },
        '&&': function(a, b) { return a && b; },
        '|': function(a, b) { return a | b; },
        '&': function(a, b) { return a & b; },
        '%': function(a, b) { return a % b; },
        '^': function(a, b) { return a ^ b; },
        '<<': function(a, b) { return a << b; },
        '>>': function(a, b) { return a >> b; },
        '>>>': function(a, b) { return a >>> b; },
    };
    var uoperators = {
        '!': function(a) { return !a; },
        '~': function(a) { return ~a; },
        '+': function(a) { return +a; },
        '-': function(a) { return -a; },
    };

    function match(o, pattern) {
        return Object.keys(pattern).every(function(k) {
            if (typeof pattern[k] !== 'object') {
                return o && pattern[k] === o[k];
            } else {
                return o && match(o[k], pattern[k]);
            }
        });
    }

    function mkliteral(value, raw) {
        if (value instanceof RegExp) {
            return {
                type: 'Literal',
                value: value,
                raw: raw
            };
        }
        if (value === undefined) {
            return {
                type: 'Identifier',
                name: 'undefined',
                pure: true,
                value: value
            };
        }
        if (value === null) {
            return {
                type: 'Identifier',
                name: 'null',
                pure: true,
                value: value
            };
        }
        if (Number.isNaN(value)) {
            return {
                type: 'Identifier',
                name: 'NaN',
                pure: true,
                value: value
            };
        } if (value < 0) {
            return {
                type: 'UnaryExpression',
                operator: '-',
                value: value,
                argument: {
                    type: 'Literal',
                    pure: true,
                    value: -value,
                    raw: JSON.stringify(-value)
                }
            }
        }
        return {
            type: 'Literal',
            pure: true,
            value: value,
            raw: JSON.stringify(value)
        };
    }

    function const_collapse(ast, scope, expandvars) {
        scope = scope || {};
        if (!ast) return ast;
        var const_collapse_scoped = function(e) {
            return const_collapse(e, scope, expandvars);
        };
        var ret, left, right, arg, value, fscope, last, pure;
        switch (ast.type) {
        case 'LogicalExpression':
        case 'BinaryExpression':
            left = const_collapse_scoped(ast.left);
            right = const_collapse_scoped(ast.right);
            if (left.pure && right.pure && ast.operator in boperators) {
                return mkliteral(boperators[ast.operator](left.value, right.value));
            } else {
                return {
                    type: ast.type,
                    operator: ast.operator,
                    left: left,
                    right: right
                };
            }
        case 'UnaryExpression':
            arg = const_collapse_scoped(ast.argument);
            if (arg.pure && ast.operator in uoperators) {
                return mkliteral(uoperators[ast.operator](arg.value));
            } else {
                return {
                    type: ast.type,
                    operator: ast.operator,
                    argument: arg,
                    prefix: ast.prefix
                };
            }
        case 'Program':
            ret = {
                type: ast.type,
                body: ast.body.map(const_collapse_scoped)
            };
            return ret;
        case 'ExpressionStatement':
            ret = {
                type: ast.type,
                expression: const_collapse_scoped(ast.expression)
            };
            ret.pure = ret.expression.pure;
            return ret;
        case 'AssignmentExpression':
            ret = {
                type: ast.type,
                operator: ast.operator,
                left: const_collapse(ast.left, scope, false),
                right: const_collapse_scoped(ast.right)
            };
            if (ret.left.type === 'Identifier' && ret.left.name in scope) {
                scope[ret.left.name].pure = false;
            }
            return ret;
        case 'CallExpression':
            ret = {
                type: 'CallExpression',
                callee: const_collapse_scoped(ast.callee),
                arguments: ast.arguments.map(const_collapse_scoped)
            };
            ret.purearg = ret.arguments.every(function(e) {
                return e.pure;
            });

            if (match(ret.callee, {
                type: 'MemberExpression',
                object: { type: 'Identifier', name: 'String' },
                property: { type: 'Identifier', name: 'fromCharCode' }
            }) || match(ret.callee, {
                type: 'MemberExpression',
                object: { type: 'Identifier', name: 'String' },
                property: { type: 'Literal', value: 'fromCharCode' }
            }) && ret.purearg) {
                value = String.fromCharCode.apply(String,
                        ret.arguments.map(function(e){return e.value;}));
                return mkliteral(value);
            }
            if (ret.callee.body && ret.callee.body.pure) {
                return mkliteral(ret.callee.body.value);
            }
            return ret;
        case 'Literal':
            return mkliteral(ast.value, ast.raw);
        case 'Identifier':
            if (expandvars && ast.name in scope && scope[ast.name].pure) {
                return mkliteral(scope[ast.name].value);
            } else {
                return ast;
            }
        case 'ArrayExpression':
            ret = {
                type: ast.type,
                elements: ast.elements.map(const_collapse_scoped)
            };
            return ret;
        case 'ObjectExpression':
            return {
                type: ast.type,
                properties: ast.properties.map(function(p) {
                    return {
                        type: p.type,
                        key: p.key,
                        value: const_collapse_scoped(p.value)
                    };
                })
            };
        case 'MemberExpression':
            ret = {
                type: ast.type,
                computed: ast.computed,
                object: const_collapse_scoped(ast.object),
                // do not expand identifiers as variables if they are not in square brackets
                property: ast.computed
                            ? const_collapse_scoped(ast.property)
                            : const_collapse(ast.property, scope, false)
            }
            // replace ['property'] with .property accessor
            if (ret.property.pure && /^[a-z_$][a-z_$0-9]*$/i.test(''+ret.property.value)) {
                ret.computed = false;
                ret.property = {
                    type: 'Identifier',
                    name: ret.property.value
                };
            }
            if (match(ret, {
                object: {type: 'Literal'},
                property: {name: 'length'}
            }) || match(ret, {
                object: {type: 'Literal'},
                property: {type: 'Literal', value: 'length'}
            })) {
                return {
                    type: 'Literal',
                    pure: true,
                    value: ret.object.value.length,
                    raw: ret.object.value.length
                };
            }
            return ret;
        case 'VariableDeclaration':
            ret = {
                type: ast.type,
                kind: ast.kind,
                declarations: ast.declarations.map(const_collapse_scoped)
            };
            ret.pure = ret.declarations.every(function(e) {
                return !e.init || e.init.pure;
            });
            return ret;
        case 'VariableDeclarator':
            ret = {
                type: ast.type,
                id: ast.id,
                init: const_collapse_scoped(ast.init)
            };
            if (ret.init && ret.init.pure) {
                scope[ast.id.name] = {
                    value: ret.init.value,
                    pure: true
                };
            } else {
                scope[ast.id.name] = {
                    value: undefined,
                    pure: false
                }
            }
            return ret;
        case 'FunctionDeclaration':
            fscope = Object.create(scope);
            ast.params.map(function(p) {
                fscope[p.name] = {value: undefined, pure: false};
            });
            if (ast.id) {
                scope[ast.id] = {value: undefined, pure: false};
            }
            return {
                type: ast.type,
                id: ast.id,
                params: ast.params,
                body: const_collapse(ast.body, fscope, false),
                test: ast.test,
                generator: ast.generator,
                expression: ast.expression
            };
        case 'FunctionExpression':
            fscope = Object.create(scope);
            ast.params.map(function(p) {
                fscope[p.name] = {value: undefined, pure: false};
            });
            if (ast.id) {
                fscope[ast.id] = {value: undefined, pure: false};
            }
            return {
                type: ast.type,
                id: ast.id,
                params: ast.params,
                defaults: ast.defaults,
                body: const_collapse(ast.body, fscope, false),
                test: ast.test,
                generator: ast.generator,
                expression: ast.expression
            };
        case 'BlockStatement':
            ret = {
                type: ast.type,
                body: ast.body.map(const_collapse_scoped)
            };
            last = ret.body && ret.body.length > 0 && ret.body[ret.body.length-1];
            pure = ret.body && ret.body.every(function(e) {
                return e.pure;
            });
            if (pure && last && last.type === 'ReturnStatement' && last.argument && last.argument.pure) {
                return {
                    type: ast.type,
                    pure: true,
                    value: last.argument.value,
                    body: [last]
                }
            } else {
                ret.pure = ret.body.every(function(e) {
                    return e.pure;
                });
                return ret;
            }
        case 'ReturnStatement':
            ret = {
                type: ast.type,
                argument: const_collapse(ast.argument, scope, true)
            };
            ret.pure = ret.argument && ret.argument.pure;
            return ret;
        case 'IfStatement':
            ret = {
                type: ast.type,
                test: const_collapse_scoped(ast.test),
                consequent: const_collapse_scoped(ast.consequent),
                alternate: const_collapse_scoped(ast.alternate)
            };
            if (ret.test.pure) {
                if (ret.test.value && ret.consequent.pure) {
                    return ret.consequent;
                }
                if (!ret.test.value && ret.alternate.pure) {
                    return ret.alternate;
                }
            }
        return ret;
        case 'DoWhileStatement':
        case 'WhileStatement':
            return {
                type: ast.type,
                test: const_collapse_scoped(ast.test),
                body: const_collapse_scoped(ast.body)
            };
        case 'ForStatement':
            return {
                type: ast.type,
                init: const_collapse_scoped(ast.init),
                test: const_collapse_scoped(ast.test),
                update: const_collapse_scoped(ast.update),
                body: const_collapse_scoped(ast.body)
            };
        case 'ForInStatement':
            return {
                type: ast.type,
                left: ast.left,
                right: const_collapse_scoped(ast.right),
                body: const_collapse_scoped(ast.body)
            };
        case 'BreakStatement':
        case 'ContinueStatement':
            return {
                type: ast.type,
                label: ast.label
            };
        case 'EmptyStatement':
        case 'ThisExpression':
            return {type: ast.type};
        case 'ConditionalExpression':
            ret = {
                type: ast.type,
                test: const_collapse_scoped(ast.test),
                consequent: const_collapse_scoped(ast.consequent),
                alternate: const_collapse_scoped(ast.alternate)
            };
            if (ret.test.pure) {
                if (ret.test.value && ret.consequent.pure) {
                    return mklit(ret.consequent.value);
                }
                if (!ret.test.value && ret.alternate.pure) {
                    return mklit(ret.alternate.value);
                }
            }
            return ret;
        case 'NewExpression':
            return {
                type: ast.type,
                callee: const_collapse_scoped(ast.callee),
                arguments: ast.arguments.map(const_collapse_scoped)
            };
        case 'SequenceExpression':
            return {
                type: ast.type,
                expressions: ast.expressions.map(const_collapse_scoped)
            };
        case 'UpdateExpression':
            return {
                type: ast.type,
                operator: ast.operator,
                argument: const_collapse(ast.argument, scope, false),
                prefix: ast.prefix
            };
        case 'TryStatement':
            return {
                type: ast.type,
                block: const_collapse_scoped(ast.block),
                guardedHandlers: ast.guardedHandlers.map(const_collapse_scoped),
                handlers: ast.handlers.map(const_collapse_scoped),
                finalizer: const_collapse_scoped(ast.finalizer),
            };
        case 'CatchClause':
            return {
                type: ast.type,
                param: ast.param,
                body: const_collapse_scoped(ast.body)
            };
        case 'ThrowStatement':
            return {
                type: ast.type,
                argument: const_collapse_scoped(ast.argument)
            };
        case 'LabeledStatement':
            return {
                type: ast.type,
                label: ast.label,
                body: const_collapse_scoped(ast.body)
            };
        default:
            console.log('unknown expression type: ' + ast.type);
            return ast;
        }
    }
    return {
        deobfuscate: const_collapse
    };
})();
