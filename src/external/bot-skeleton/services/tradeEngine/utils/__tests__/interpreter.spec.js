jest.mock('@/components/shared', () => ({ isMultiplierContract: jest.fn(() => false) }));
jest.mock('@/utils/clone', () => ({ __esModule: true, default: jest.fn(value => value) }));
jest.mock('@deriv/js-interpreter', () => ({ __esModule: true, default: function MockJSInterpreter() {} }));
jest.mock('../../../../constants/messages', () => ({ unrecoverable_errors: [] }));
jest.mock('../../../../utils/observer', () => ({
    observer: {
        emit: jest.fn(),
        getState: jest.fn(() => []),
        register: jest.fn(),
    },
}));
jest.mock('../../../api/api-base', () => ({
    api_base: {
        clearSubscriptions: jest.fn(),
        is_stopping: false,
    },
}));
jest.mock('../../Interface', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../cliTools', () => ({ createScope: jest.fn() }));

import Interface from '../../Interface';
import { api_base } from '../../../api/api-base';
import { STOP } from '../../trade/state/constants';
import { observer as globalObserver } from '../../../../utils/observer';
import { createScope } from '../cliTools';
import Interpreter from '../interpreter';

describe('Interpreter Stop while awaiting pair proposals', () => {
    beforeEach(() => {
        api_base.is_stopping = false;
        api_base.clearSubscriptions.mockClear();
        globalObserver.emit.mockClear();
        globalObserver.getState.mockReturnValue([]);
    });

    it('cancels pending proposals and resolves Stop without waiting for API cleanup', async () => {
        const ticksService = { unsubscribeFromTicksService: jest.fn(() => new Promise(() => {})) };
        const scope = { observer: {}, stopped: false, ticksService };
        const tradeEngine = {
            cancelPendingProposalRequests: jest.fn(),
            contractId: '',
            store: { dispatch: jest.fn() },
        };
        createScope.mockReturnValue(scope);
        Interface.mockReturnValue({ getInterface: jest.fn(() => ({})), tradeEngine });

        const interpreter = Interpreter();
        await expect(interpreter.stop()).resolves.toBeUndefined();

        expect(scope.stopped).toBe(true);
        expect(tradeEngine.cancelPendingProposalRequests).toHaveBeenCalledTimes(1);
        expect(tradeEngine.store.dispatch).toHaveBeenCalledWith({ type: STOP });
        expect(api_base.clearSubscriptions).toHaveBeenCalledTimes(1);
        expect(ticksService.unsubscribeFromTicksService).toHaveBeenCalledTimes(1);
        expect(api_base.is_stopping).toBe(false);
    });
});
